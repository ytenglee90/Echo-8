import { expect, test, type Page } from '@playwright/test';
import type { CanvasControlPlan } from '../../src/protocols/canvas-control.ts';
import { parseProject, serializeProject } from '../../src/plugins/import-export/codec.ts';
import { ApplicationKernel } from '../../src/core/kernel.ts';
import { createSelectionPlugin } from '../../src/plugins/selection/model.ts';
import { createTextNodePlugin } from '../../src/plugins/text-node/plugin.ts';
import type { ProjectSource } from '../../src/protocols/files.ts';
import { installLocalLanguageAssets } from './local-language-assets.ts';
import { openModelSettings } from './model-settings.ts';

const LOCAL_MIXED_GRAPH = '创建一张「主角｜林渊」，一张「主角」的文本框，一张「正文｜第001章」，把「主角｜林渊」改成#a83d44，把「主角｜林渊」和「主角」组成一个群组名为「主角组」，「主角｜林渊」虚线连接到「正文｜第001章」，「主角组」连接到「正文｜第001章」';

const plan: CanvasControlPlan = { version: 1, actions: [
  { type: 'create-node', ref: 'hero', title: '主角｜林渊', text: '修钟学徒。\n\n寻找父亲🧭', color: '#a83d44' },
  { type: 'create-node', ref: 'heading', title: '主角', presentation: 'text-box', color: '#a83d44' },
  { type: 'create-node', ref: 'chapter', title: '正文｜第001章', text: '旧钟响了第十三下。', color: '#454851' },
  { type: 'create-group', ref: 'people', title: '主角组', members: ['hero', 'heading'] },
  { type: 'create-connection', ref: 'quote', from: 'hero', to: 'chapter', line: 'dashed', label: '引用' },
  { type: 'create-connection', ref: 'order', from: 'people', to: 'chapter', line: 'solid', label: '展开' },
] };

export function canvasControlScenarios(url: string): void {
  test.beforeEach(async ({page})=>installLocalLanguageAssets(page));
  test('settings page instructions execute locally with a configured provider and zero model calls', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => { calls++; return route.abort(); });
    await page.setViewportSize({ width: 1800, height: 1000 });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    for (const [request, heading, close] of [
      ['打开指令与偏好', '指令与偏好', '关闭指令与偏好'],
      ['打开插件', '插件', '关闭插件中心'],
      ['打开检索', '检索', '关闭检索设置'],
      ['打开模型连接设置', 'AI 模型连接', '关闭 AI 模型连接'],
    ]) {
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
      await ai.locator('.ai-composer textarea').fill(request!);
      await ai.locator('.ai-composer textarea').press('Enter');
      const center = page.getByRole('region', { name: '设置中心', exact: true });
      await expect(center.getByRole('heading', { name: heading!, exact: true })).toBeVisible();
      await center.getByRole('button', { name: close!, exact: true }).click();
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    }
    await expect(ai.getByLabel('本轮 Token 用量', { exact: true }).last()).toContainText('输入 0');
    await expect(page.getByRole('navigation', { name: '主工具栏' }).getByRole('button', { name: '画布控制', exact: true })).toHaveCount(0);
    expect(calls).toBe(0);
  });
  test('delete-all means canvas nodes and remains a reviewed single undo with zero model calls', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => { calls++; return route.abort(); });
    await seedCanvas(page, url, [{ title: '删除甲', body: '正文甲' }, { title: '删除乙', body: '正文乙' }, { title: '删除丙', body: '正文丙' }], true);
    await configure(page, url, 'openai', undefined, 'direct', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('删除所有');
    await ai.locator('.ai-composer textarea').press('Enter');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control).toContainText('删除甲');
    await expect(control).toContainText('删除乙');
    await expect(control).toContainText('删除丙');
    await expect(page.locator('.text-node-card')).toHaveCount(3);
    await control.getByRole('button', { name: /^应用/u }).click();
    await expect(page.locator('.text-node-card')).toHaveCount(0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.text-node-card')).toHaveCount(3);
    expect(calls).toBe(0);
  });
  test('rewrite into a named new node generates only prose and creates an undoable result', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls++;
      const body = route.request().postDataJSON() as { messages: Array<{content: string}>; tools?: unknown };
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body.messages)).toContain('原正文里只有这项事实');
      expect(JSON.stringify(body.messages)).toContain('应用已核对本轮写入目标和范围');
      const content = JSON.stringify({ texts: ['周明瑞在晨光中醒来，原正文里只有这项事实。'] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' });
    });
    await seedCanvas(page, url, [{ title: '未命名节点', body: '原正文里只有这项事实。' }], true);
    await configure(page, url, 'openai', undefined, 'direct', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('改写未命名节点的内容，用新的节点插入内容，标题为周明瑞');
    await ai.locator('.ai-composer textarea').press('Enter');
    const result = page.getByRole('article', { name: /文本节点：周明瑞$/u });
    await expect(result).toContainText('周明瑞在晨光中醒来');
    await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    await ai.locator('.ai-composer textarea').fill('选中未命名节点');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: /文本节点：未命名节点$/u })).toContainText('原正文里只有这项事实');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(result).toHaveCount(0);
    expect(calls).toBe(1);
  });
  test('stopping an active streamed answer closes its model connection and records cancellation', async ({ page }, info) => {
    await page.addInitScript(() => {
      const actualFetch = globalThis.fetch.bind(globalThis);
      const fixture = { calls: 0, aborted: false };
      Object.defineProperty(globalThis, '__modelStopFixture', { value: fixture });
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith('https://canvas-control.test/')) return actualFetch(input, init);
        fixture.calls++;
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"尚未完成的流式内容"}}]}\n\n'));
            init?.signal?.addEventListener('abort', () => {
              fixture.aborted = true;
              controller.error(init.signal!.reason);
            }, { once: true });
          },
        }), { headers: { 'content-type': 'text/event-stream' } }));
      };
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@通用 为什么海水会涨潮？');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('article', { name: 'AI 正在流式生成', exact: true })).toContainText('尚未完成的流式内容');
    await ai.screenshot({ path: info.outputPath('stop-streamed-answer.png') });
    await ai.locator('.ai-composer textarea').fill('下一条尚未发送的草稿');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.locator('.ai-composer textarea')).toHaveValue('下一条尚未发送的草稿');
    await ai.getByRole('button', { name: '停止本次生成', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__modelStopFixture'))).toEqual({ calls: 1, aborted: true });
    await expect(ai.getByRole('article', { name: 'AI 正在流式生成', exact: true })).toHaveCount(0);
    await expect(ai.locator('.ai-chat-bubble.assistant').filter({ hasText: '尚未完成的流式内容' })).toHaveCount(0);
    await ai.getByRole('button', { name: '打开实时操作日志', exact: true }).click();
    const logs = page.getByRole('region', { name: '实时操作日志', exact: true });
    await expect(logs.getByRole('listitem').filter({ hasText: 'AI 回答' }).first()).toContainText('已取消');
  });
  test('stopping context preparation remains available after reopening the assistant', async ({ page }, info) => {
    let waiting = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(/https:\/\/huggingface\.co\/Xenova\/bge-small-zh-v1\.5\//u, async route => {
      waiting = true;
      await gate;
      await route.fallback();
    });
    try {
      await configure(page, url, 'openai', undefined, 'direct');
      const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
      await ai.locator('.ai-composer textarea').fill('把这两张配成海港的感觉');
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect.poll(() => waiting).toBe(true);
      await expect(ai.getByRole('status')).toContainText('正在解析指令并核对工作区');
      await ai.getByRole('button', { name: '关闭AI 助手', exact: true }).click();
      await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
      await expect(ai.getByRole('button', { name: '停止本次生成', exact: true })).toBeEnabled();
      await ai.screenshot({ path: info.outputPath('stop-context-preparation.png') });
      await ai.getByRole('button', { name: '停止本次生成', exact: true }).click();
      await expect(ai.getByRole('status')).toContainText('已停止本次生成');
      release();
      await ai.locator('.ai-composer textarea').fill('新建一个叫「准备取消后」的节点');
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(ai.getByRole('status')).toContainText('已直接完成 1 项操作');
    } finally { release(); }
  });
  for (const mode of ['answer', 'planning'] as const) test(`stopping ${mode} aborts the model request and rejects its late response`, async ({ page }) => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('https://canvas-control.test/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls++;
      await held;
      await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        json: { choices: [{ message: { role: 'assistant', content: '迟到的模型答案不能写入' }, finish_reason: 'stop' }] } }).catch(() => undefined);
    });
    try {
      await configure(page, url, 'openai', undefined, 'direct');
      const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
      const input = ai.locator('.ai-composer textarea');
      await input.fill(mode === 'answer' ? '@通用 为什么海水会涨潮？' : '把画布背景调整得更护眼');
      await input.press('Enter');
      await expect.poll(() => calls).toBe(1);
      const aborted = page.waitForEvent('requestfailed', request => request.url().startsWith('https://canvas-control.test/'));
      await ai.getByRole('button', { name: '停止本次生成', exact: true }).click();
      await aborted;
      await expect(ai.getByRole('status')).toContainText('已停止本次生成');
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
      release();
      await input.fill('新建一个叫「停止后仍可操作」的节点');
      await input.press('Enter');
      await expect(ai.getByRole('status')).toContainText('已直接完成 1 项操作');
      await expect(ai.locator('.ai-chat-bubble.assistant')).not.toContainText('迟到的模型答案不能写入');
      expect(calls).toBe(1);
    } finally { release(); }
  });
  test('reported zoom, autosave, shortcut and numbered immersive commands execute through actual owners without model calls', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => { calls++; return route.fulfill({ status: 500, body: 'Unexpected model request' }); });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const ask = async (text: string) => {
      const replies = ai.locator('.ai-chat-bubble.assistant:not(.ai-streaming-response)');
      const count = await replies.count();
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
      await ai.locator('.ai-composer textarea').fill(text);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(replies).toHaveCount(count + 1);
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    };
    await ask('画布缩放80%');
    await expect(page.getByRole('textbox', { name: '画布缩放 80%', exact: true })).toHaveValue('80');
    await ask('设置自动保存时间为1分钟');
    await expect(ai.getByRole('status')).toContainText('自动保存间隔为 60 秒');
    await ask('设置放大画布的快捷键为：ctrl+]');
    await expect(ai.getByRole('status')).toContainText('快捷键已保存为');
    await ask('新建一个叫「空白 31」的节点');
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项操作');
    await ask('进入空白31的沉浸编辑');
    await expect(page.getByRole('region', { name: '沉浸式写作', exact: true })).toBeVisible();
    expect(calls).toBe(0);
  });
  test('group management exposes actual names, renaming and member counts', async ({ page }, info) => {
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('新建两张管理测试，两张管理测试打一个组');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 3 项操作');
    await page.getByRole('button', { name: '群组管理', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '加入或移出已有群组', exact: true });
    await expect(panel.getByRole('region', { name: '全部群组' })).toBeVisible();
    await panel.getByRole('textbox', { name: '群组 1 名称', exact: true }).fill('我的人物组');
    await panel.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(panel.getByRole('form', { name: '管理群组 我的人物组', exact: true })).toContainText('2 个节点');
    await panel.getByRole('button', { name: '关闭群组成员管理', exact: true }).click();
    const frame = page.locator('.group-frame');
    await frame.hover({ position: { x: 40, y: 10 } });
    const badge = page.getByRole('button', { name: '修改群组名称：我的人物组', exact: true });
    await expect(badge).toHaveText('1');
    await expect(badge).toHaveAttribute('title', /我的人物组 · 2 个节点/u);
    await page.screenshot({ path: info.outputPath('group-hover-number.png') });
    await badge.click();
    const rename = page.getByRole('form', { name: '修改群组 1 名称' });
    await rename.getByRole('textbox', { name: '群组 1 名称', exact: true }).fill('直接改名的人物组');
    await page.screenshot({ path: info.outputPath('group-inline-rename.png') });
    await rename.getByRole('button', { name: '保存群组名称', exact: true }).click();
    await expect(frame).toHaveAttribute('aria-label', '群组：直接改名的人物组，包含 2 个节点');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(frame).toHaveAttribute('aria-label', '群组：我的人物组，包含 2 个节点');
  });
  for (const bodyUpdate of [false, true]) test(`model removal from a numbered group handles pending body update ${bodyUpdate} and undoes once`, async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls++;
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      const input = JSON.parse(request.messages.at(-1)!.content) as { directory?: { nodes: Array<{ id: string; title: string }>; groups: Array<{ id: string; number: number }> } };
      const group = input.directory?.groups.find(group => group.number === 1);
      const node = input.directory?.nodes.find(node => node.title.replaceAll(' ', '') === '空白1');
      const output = !input.directory ? { actions: ['group.remove'], clarification: '' } : {
        steps: [{ action: 'group.remove', arguments: { groupId: group!.id, nodeIds: [node!.id] } }], clarification: '',
      };
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }] } });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const ask = async (text: string) => {
      const replies = ai.locator('.ai-chat-bubble.assistant:not(.ai-streaming-response)');
      const count = await replies.count();
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
      await ai.locator('.ai-composer textarea').fill(text); await ai.locator('.ai-composer textarea').press('Enter');
      await expect(replies).toHaveCount(count + 1);
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    };
    await ask('新建60张空白，60张空白打一个组');
    const frame = page.locator('.group-frame');
    await expect(frame).toHaveAttribute('aria-label', /包含 60 个节点/u);
    await ask('选中空白1');
    await expect(ai.getByRole('status')).toContainText('已选中');
    if (bodyUpdate) {
      await ask('把空白1打开在右侧');
      await expect(page.locator('.editor-writing-area').first()).toBeVisible();
    }
    await ask('空白1踢出群组1');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control.getByRole('list', { name: '模型解析步骤' })).toContainText('从指定群组移出');
    await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    if (bodyUpdate) {
      await page.locator('.editor-writing-area').first().fill('预览生成后补全的正文，应在移出和撤销后保留。');
      await page.getByRole('button', { name: '命令面板', exact: true }).click();
      const palette = page.getByRole('dialog', { name: '命令面板' });
      await palette.getByRole('textbox', { name: '搜索命令' }).fill('画布控制');
      await palette.getByRole('option', { name: /^画布控制/u }).click();
    }
    await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await expect(frame).toHaveAttribute('aria-label', /包含 59 个节点/u);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(frame).toHaveAttribute('aria-label', /包含 60 个节点/u);
    if (bodyUpdate) await expect(page.locator('.editor-writing-area').first()).toContainText('预览生成后补全的正文，应在移出和撤销后保留。');
    expect(calls).toBeGreaterThanOrEqual(1);
  });
  test('reported review supports select all, deselect all, editable titles and collision recovery without partial writes', async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const ask = async (text: string) => { await ai.locator('.ai-composer textarea').fill(text); await ai.locator('.ai-composer textarea').press('Enter'); };
    const savedObjects = async () => {
      await page.getByRole('button', { name: '命令面板', exact: true }).click();
      const palette = page.getByRole('dialog', { name: '命令面板' });
      await palette.getByRole('textbox', { name: '搜索命令' }).fill('另存本地副本');
      const downloading = page.waitForEvent('download');
      await palette.getByRole('option', { name: /^另存本地副本/u }).click();
      const stream = await (await downloading).createReadStream();
      const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const project = await parseProject(new Blob([Buffer.concat(chunks)]));
      return Object.fromEntries(['textNode', 'groups', 'connections'].map(namespace =>
        [namespace, Object.keys(project.document.namespaces[namespace] ?? {}).sort()]));
    };
    await ask('新建一个叫「空白 1」的节点');
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项操作');
    const before = await savedObjects();
    await openControl(page);
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await control.getByRole('combobox', { name: '画布生成方式', exact: true }).selectOption('review');
    await control.getByRole('button', { name: '关闭画布控制', exact: true }).click();
    await ask('生成60张空白，三张人物，两张角色，一张势力，一张地图，地图连接势力实线。60张空白打一个组');
    await expect(control.getByRole('checkbox')).toHaveCount(69);
    await expect(control.getByText('已选 69 / 69 项', { exact: true })).toBeVisible();
    await control.getByRole('button', { name: '取消全选', exact: true }).click();
    await expect(control.getByRole('button', { name: '应用选中的 0 项', exact: true })).toBeDisabled();
    await control.getByRole('button', { name: '全选', exact: true }).click();
    await control.getByRole('textbox', { name: '第 1 项新建标题', exact: true }).fill('空白 1');
    await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await expect(control.getByRole('alert')).toContainText('已被使用');
    expect(await savedObjects()).toEqual(before);
    await control.getByRole('button', { name: '一键避开重名', exact: true }).click();
    await expect(control.getByRole('textbox', { name: '第 1 项新建标题', exact: true })).not.toHaveValue('空白 1');
    await control.getByRole('textbox', { name: '第 1 项新建标题', exact: true }).fill('我的第一张空白');
    await control.screenshot({ path: info.outputPath('select-all-and-edit-titles.png') });
    await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await expect(control).toContainText('已回读核对 69 项操作');
    const applied = await savedObjects();
    expect(applied.textNode).toHaveLength(before.textNode!.length + 67);
    expect(applied.groups).toHaveLength(before.groups!.length + 1);
    expect(applied.connections).toHaveLength(before.connections!.length + 1);
    await expect(page.locator('.group-frame')).toHaveCount(1);
  });
  test('semantic fallback uses the chosen model and waits for confirmation while model selection stays beside the composer', async ({ page }, info) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls++;
      const body = JSON.stringify({ steps: [{ action: 'appearance.preset.apply', arguments: { id: 'eye-care' } }], clarification: '' });
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        json: { choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }], usage: { prompt_tokens: 99, completion_tokens: 25 } } });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('把画布背景调整得更护眼');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('尚未执行');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control.getByRole('list', { name: '模型解析步骤' })).toContainText('切换完整主题配色');
    expect(calls).toBe(2);
    await expect(page.locator('.canvas-surface')).not.toHaveCSS('background-color', 'rgb(228, 232, 218)');
    await expect(ai.getByRole('combobox', { name: '当前模型平台' })).toBeVisible();
    const model = await ai.getByRole('combobox', { name: '当前模型平台' }).boundingBox();
    const input = await ai.locator('.ai-composer textarea').boundingBox();
    expect(model!.y).toBeGreaterThanOrEqual(input!.y + input!.height);
    const footer = ai.locator('.ai-composer-footer');
    await expect(footer.getByRole('button', { name: /^Prompt：/u })).toBeVisible();
    expect((await footer.getByRole('button', { name: /^Prompt：/u }).textContent())?.trim()).toBe('');
    expect(await footer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await expect(page.locator('.canvas-surface')).toHaveCSS('background-color', 'rgb(228, 232, 218)');
    await control.getByRole('button', { name: '关闭画布控制', exact: true }).click();
    await ai.locator('.ai-composer textarea').fill('帮我换成暗调'); await ai.locator('.ai-composer textarea').press('Enter');
    await expect(page.locator('.canvas-surface')).toHaveCSS('background-color', 'rgb(24, 25, 27)');
    await ai.getByRole('button', { name: '查看发送内容', exact: true }).first().click();
    const inspection = page.getByRole('dialog', { name: '本轮发送内容', exact: true });
    await expect(inspection).toBeVisible();
    const ink = await inspection.evaluate(element => getComputedStyle(element).color);
    expect((ink.match(/\d+/gu) ?? []).slice(0, 3).every(value => Number(value) > 180)).toBe(true);
    await expect(inspection.getByLabel('实际请求正文').first()).toBeVisible();
    await inspection.screenshot({ path: info.outputPath('model-plan-request-inspection.png') });
  });
  test('conversational theme names apply all three complete presets locally and the chooser matches the interface', async ({ page }, info) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() !== 'OPTIONS') calls++;
      return route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'Unexpected model request' });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const input = ai.locator('.ai-composer textarea');
    const colors = page.getByRole('region', { name: '全局颜色设置', exact: true });
    const openColors = async () => {
      await page.getByRole('button', { name: '命令面板', exact: true }).click();
      const commands = page.getByRole('dialog', { name: '命令面板' });
      await commands.getByRole('textbox', { name: '搜索命令' }).fill('打开全局颜色设置');
      await commands.getByRole('option', { name: /^打开全局颜色设置/u }).click();
    };
    for (const [prompt, label, background, toolbar] of [
      ['帮我换成暗调', 'B 暗调', 'rgb(24, 25, 27)', '#1c1e23'],
      ['能不能帮我把主题换成护眼？', 'C 护眼', 'rgb(228, 232, 218)', '#eaf0e2'],
      ['恢复明调', 'A 明调', 'rgb(239, 239, 236)', '#fafaf9'],
      ['切换主题到深色', 'B 暗调', 'rgb(24, 25, 27)', '#1c1e23'],
    ]) {
      await input.fill(prompt!); await input.press('Enter');
      await expect(ai.getByRole('status')).toContainText('完整配色已应用');
      await expect(page.locator('.canvas-surface')).toHaveCSS('background-color', background!);
      await expect.poll(() => page.locator('.top-bar').evaluate(element => getComputedStyle(element).getPropertyValue('--toolbar').trim())).toBe(toolbar!);
      await openColors();
      await expect(colors.getByRole('button', { name: new RegExp(`^${label}`, 'u') })).toHaveAttribute('aria-pressed', 'true');
      await colors.getByRole('button', { name: '关闭全局颜色设置', exact: true }).click();
      await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
      expect(calls).toBe(0);
    }
    await input.fill('切换主题'); await input.press('Enter');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    for (const name of ['明调', '暗调', '护眼']) await expect(control.getByRole('button', { name, exact: true })).toBeVisible();
    await control.getByRole('button', { name: '护眼', exact: true }).click();
    await expect(page.locator('.canvas-surface')).toHaveCSS('background-color', 'rgb(228, 232, 218)');
    await openColors();
    await expect(colors.getByRole('button', { name: /^C 护眼/u })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: info.outputPath('assistant-eye-care-theme.png') });
    expect(calls).toBe(0);
  });
  test('supported canvas controls keep themes backgrounds and annotations local with a configured model', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() !== 'OPTIONS') calls++;
      return route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'Unexpected model request' });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string, expected: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(ai.getByRole('status')).toContainText(expected);
      await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
      expect(calls).toBe(0);
    };
    await send('切换主题到深色', '已切换为暗调主题');
    await send('把背景颜色改成浅蓝', '已准备画布背景颜色');
    await expect(control.getByLabel('画布背景预览')).toContainText('#add8e6');
    await control.getByRole('button', { name: '应用背景', exact: true }).click();
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await send('默认注释颜色改成红色', '已将默认注释颜色改为 #c43d49');
    await send('新建一个叫本地注释测试的节点', '已直接完成 1 项操作');
    await send('选中本地注释测试', '已选中 1 个节点');
    await send('添加注释：这条注释完全在本地添加', '已添加标注');
    await expect(page.getByRole('textbox', { name: '注释正文' })).toHaveValue('这条注释完全在本地添加');
    await send('放大画布', '已更新画布视图或选区');
    await send('取消选择', '已更新画布视图或选区');
    await send('把不存在的卡片改成蓝色', '没有找到');
    await send('执行本地命令：打开查找替换', '已提交本地命令');
    await expect(page.getByRole('region', { name: '查找替换', exact: true })).toBeVisible();
    expect(calls).toBe(0);
  });
  test('writing the last complete answer into a named card is a local operation with zero extra tokens', async ({ page }) => {
    let calls = 0;
    const draft = '雨夜里，他把最后一盏灯让给陌生人。';
    const unrelated = '正弦和余弦是三角函数。';
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls++;
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: calls === 1 ? draft : unrelated }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string, expected: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(ai.getByRole('status')).toContainText(expected);
    };
    await send('新建一个叫草稿目标的节点', '已直接完成 1 项');
    await send('新建一个叫「草稿目标中」的节点', '已直接完成 1 项');
    await send('写入到草稿目标中', '没有找到可原样写入的完整草稿');
    expect(calls).toBe(0);
    await send('写一段人物小传，只回答正文', '回答完成');
    await expect(ai.getByRole('log')).toContainText(draft);
    await send('写入到草稿目标中', '已直接完成 1 项');
    await expect(page.getByRole('article', { name: /文本节点：草稿目标$/u })).toContainText(draft);
    const literal = page.getByRole('article', { name: /文本节点：草稿目标中$/u });
    await expect(literal).not.toContainText(draft);
    await send('什么是三角函数？', '回答完成');
    await expect(ai.getByRole('log')).toContainText(unrelated);
    await send('把上面那段人物小传填入草稿目标中', '已直接完成 1 项');
    await expect(literal).toContainText(draft);
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    expect(calls).toBe(2);
  });
  test('the reported character sequence connects the named nodes and writes directly into the role card', async ({ page }) => {
    let calls = 0;
    const biography = '林见秋在社区护理站值夜班。';
    const followup = '写一段人物小传，然后写入到角色中';
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls++;
      const body = route.request().postDataJSON() as { messages: Array<{ role: string; content: string }>; tools?: unknown };
      expect(body.tools).toBeUndefined();
      const original = body.messages.at(-1);
      const askingIdentity = original?.content.endsWith('\n你是谁');
      if (askingIdentity) {
        expect(body.messages.filter(message => message.role !== 'system')).toEqual([original]);
        expect(JSON.stringify(body.messages)).not.toMatch(/林见秋|人物连接到角色中|设计出人物小传/u);
      } else {
        expect(original).toEqual({ role: 'user', content: '用户要求（原文）：\n' + (calls === 1 ? '角色中，设计出人物小传' : followup) });
        expect(JSON.stringify(body.messages)).toContain('应用已核对本轮写入目标和范围');
      }
      const content = askingIdentity ? '我是 Echo-8 的画布助手。' : JSON.stringify({ text: biography });
      const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: ['data: ' + chunk, 'data: [DONE]', ''].join('\n\n') });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const input = ai.locator('.ai-composer textarea');
    await input.fill('建一个角色，一个人物，四个空白，空白群组，人物连接到角色中。');
    await input.press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 8 项操作');
    await expect(page.locator('.connection-path:not(.title-connection)')).toHaveCount(1);
    await expect(page.locator('.group-frame')).toHaveCount(1);
    expect(calls).toBe(0);
    await input.fill('角色中，设计出人物小传');
    await input.press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项操作');
    const role = page.getByRole('article', { name: /文本节点：角色$/u });
    await expect(role).toContainText(biography);
    await expect(page.getByRole('article', { name: /文本节点：人物$/u })).not.toContainText(biography);
    expect(calls).toBe(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(role).not.toContainText(biography);
    await expect(page.locator('.connection-path:not(.title-connection)')).toHaveCount(1);
    await input.fill(followup);
    await input.press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项操作');
    await expect(role).toContainText(biography);
    await input.fill('你是谁');
    await expect(ai.locator('.ai-composer')).not.toContainText('使用历史记忆');
    await input.press('Enter');
    await expect(ai.getByRole('status')).toContainText('回答完成');
    expect(calls).toBe(3);
  });
  test('creating a card with prose asks the model only for text and writes the locally bound card', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls++;
      const body = route.request().postDataJSON() as { messages: Array<{ content: string }>; tools?: unknown };
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body.messages)).toContain('不要调用画布工具或输出操作计划');
      const content = JSON.stringify({ texts: ['她总替别人修伞，却从不肯为自己遮雨。'] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('创建一张人物卡，并写一段人物小传');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(page.getByRole('article', { name: /文本节点：人物卡$/u })).toContainText('她总替别人修伞');
    expect(calls).toBe(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByRole('article', { name: /文本节点：人物卡$/u })).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.getByRole('article', { name: /文本节点：人物卡$/u })).toContainText('她总替别人修伞');
  });
  test('reported counted grouping keeps outside cards separate and unpunctuated targets receive generated prose', async ({ page }) => {
    const calls: string[] = [];
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      const body = route.request().postDataJSON() as { messages: Array<{ content: string }>; tools?: unknown };
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body.messages)).toContain('应用已核对本轮写入目标和范围');
      const prompt = body.messages.at(-1)!.content;
      calls.push(prompt);
      const content = JSON.stringify({ text: prompt.includes('武器') ? '武器卡的示例正文。' : '架空势力的示例正文。' });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
    };
    await send('生成一张角色，一张人物，3张空白，1张武器，3张空白群组，武器连接到人物。');
    await expect(ai.getByRole('status')).toContainText('已直接完成 8 项');
    const frame = page.locator('.group-frame');
    await expect(frame).toHaveCount(1);
    const frameBox = (await frame.boundingBox())!;
    const card = (title: string) => page.getByRole('article', { name: new RegExp(`文本节点：${title}$`, 'u') });
    for (const title of ['人物', '角色', '武器']) {
      const box = (await card(title).boundingBox())!;
      expect(box.y + box.height).toBeLessThan(frameBox.y);
    }
    expect(calls).toEqual([]);
    await send('武器 里生成一把武器设计');
    await expect(card('武器')).toContainText('武器卡的示例正文。');
    await send('空白 1里生成势力设计');
    await expect(card('空白 1')).toContainText('架空势力的示例正文。');
    await expect(card('空白 2')).not.toContainText('示例正文');
    expect(calls).toHaveLength(2);
  });

  test('a delegated biography name is generated once and updates only the bound field on approval', async ({ page }) => {
    await seedCanvas(page, url, [{ title: '角色', body: '人物小传\n姓名：沈昭秋\n年龄：34岁' }, { title: '人物' }]);
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls++;
      const body = route.request().postDataJSON() as { messages: Array<{ content: string }>; tools?: unknown };
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body.messages)).toContain('要求修改时给出与原值不同的新值');
      expect(JSON.stringify(body.messages)).toContain('沈昭秋');
      const content = JSON.stringify({ texts: ['沈砚舟'] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const input = ai.locator('.ai-composer textarea');
    await input.fill('修改人物小传内容，改个姓名');
    await input.press('Enter');
    const role = page.getByRole('article', { name: /文本节点：角色$/u });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control.getByRole('button', { name: '应用整份计划' })).toBeVisible();
    await expect(role).toContainText('姓名：沈昭秋');
    await input.fill('你决定');
    await input.press('Enter');
    await expect(ai.getByRole('log')).toContainText('仍待确认');
    expect(calls).toBe(1);
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(role).toContainText('姓名：沈砚舟');
    await expect(role).toContainText('年龄：34岁');
    await expect(page.getByRole('article', { name: /文本节点：人物$/u })).not.toContainText('沈砚舟');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(role).toContainText('姓名：沈昭秋');
  });
  for (const verb of ['造', '建', '新建', '创建']) test(`reported card batch with ${verb} groups blanks and connects roles offline`, async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill(verb + '一张角色，一张人物，4张空白卡，空白卡群组，角色连接到人物。');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 8 项操作');
    const cards = page.getByRole('article', { name: /文本节点：(角色|人物|空白 [1-4])$/u });
    await expect(cards).toHaveCount(6);
    await expect(page.locator('.group-frame')).toHaveCount(1);
    await expect(page.locator('.connection-path:not(.title-connection)')).toHaveCount(1);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText('本轮 Token：输入 0 · 输出 0');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await expect(page.locator('.group-frame')).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(cards).toHaveCount(6);
    await expect(page.locator('.group-frame')).toHaveCount(1);
  });
  test('numbered dashed connections and all-dashed shared junctions use zero cloud tokens', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string, expected: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(ai.getByRole('status')).toContainText(expected);
    };
    await send('造一张角色，一张人物，4张空白卡，空白卡群组，角色连接到人物。', '已直接完成 8 项操作');
    await send('空白 1、2、3、4虚线连接到人物', '已直接完成 4 项操作');
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(4);
    await send('所有虚线，添加一个中转点', '已为 4 条虚线添加 1 个共用中转点');
    await expect(page.locator('.connection-junction')).toHaveCount(1);
    await expect(page.locator('.connection-path:not(.title-connection)')).toHaveCount(1);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText(Array(3).fill('本轮 Token：输入 0 · 输出 0'));
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.connection-junction')).toHaveCount(0);
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(4);
  });

  test('preview-only layout and status follow-ups remain local through apply and undo', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string, expected: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(ai.getByRole('status')).toContainText(expected);
    };
    await send('创建一张排版甲卡，一张排版乙卡', '已直接完成 2 项操作');
    await send('选中排版甲卡和排版乙卡', '已选中 2 个节点');
    await send('这几张卡排一行，先别执行，给我看看方案', '已生成 2 项画布操作计划');
    const apply = control.getByRole('button', { name: '应用整份计划' });
    await expect(apply).toBeVisible();
    await send('刚才那批到底执行了吗', '回答完成');
    await expect(ai).toContainText('仍待确认');
    await apply.click();
    await expect(control).toContainText('已回读核对 2 项操作');
    await send('刚才那批到底执行了吗', '回答完成');
    await expect(ai).toContainText('这项画布操作已经完成');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await send('刚才那批到底执行了吗', '回答完成');
    await expect(ai).toContainText('这项画布操作已经撤销');
    await send('新建一个叫独立草稿的节点', '已直接完成 1 项操作');
    await send('再建一份', '已直接完成 1 项操作');
    await expect(page.getByRole('article', { name: /文本节点：独立草稿(?: 2)?$/u })).toHaveCount(2);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText(Array(8).fill('本轮 Token：输入 0 · 输出 0'));
  });
  test('native assistant actions work offline and reject a changed cut selection', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string, expected: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(ai.getByRole('status')).toContainText(expected);
    };
    await send('创建一张甲卡，一张乙卡', '已直接完成 2 项操作');
    await send('在「甲卡」上添加标注：「保留原文」', '已添加标注');
    const marker = page.getByRole('button', { name: '双击打开注释：保留原文' });
    await expect(marker).toHaveCount(1);
    await send('选中乙卡', '已选中 1 个节点');
    await send('复制选中节点', '已复制 1 个选中项');
    await send('粘贴到画布', '已粘贴 1 个选中项');
    await send('撤销上一步', '已撤销上一项');
    await send('导航栏颜色改成 #314159', '已将导航栏颜色改为 #314159');
    await send('选中甲卡', '已选中 1 个节点');
    await send('剪切选中的卡片', '请在画布控制中确认');
    await send('选中乙卡', '已选中 1 个节点');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('alert')).toContainText('选区已变化');
    await expect(page.getByRole('article', { name: '文本节点：甲卡' })).toHaveCount(1);
    await expect(page.getByRole('article', { name: '文本节点：乙卡' })).toHaveCount(1);
    await control.getByRole('button', { name: '放弃', exact: true }).click();
    await send('剪切选中的卡片', '请在画布控制中确认');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(ai.getByRole('status')).toContainText('已剪切 1 个选中项到内部剪贴板');
    await expect(page.getByRole('article', { name: '文本节点：甲卡' })).toHaveCount(1);
    await expect(page.getByRole('article', { name: '文本节点：乙卡' })).toHaveCount(0);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText(Array(11).fill('本轮 Token：输入 0 · 输出 0'));
  });

  test('a distant chosen draft sends one exact version and keeps its first sentence', async ({ page }) => {
    const requests: Array<{ messages: Array<{ role: string; content: string }>; max_tokens: number }> = [];
    const firstSentence = '午夜的钟响了。';
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      requests.push(route.request().postDataJSON() as (typeof requests)[number]);
      const content = requests.length === 1 ? '第一版：\n雨水落进旧井。\n\n第二版：\n' + firstSentence + '她推开门。' :
        requests.length === 2 ? '已记下你选的版本。' : requests.length === 3 ? '这里是独立问题的回答。' : '她穿过空荡荡的花房。';
      return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string, expected: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(ai.getByText(expected, { exact: false }).last()).toBeVisible();
      await expect(ai.getByRole('status')).toContainText('回答完成');
    };
    await send('请为第二幕写两个开头。', '她推开门。');
    await send('第二个更好，先留着。', '已记下你选的版本。');
    await send('什么是第三人称限知？', '这里是独立问题的回答。');
    await send('把第二版压到 200 字，第一句别动', firstSentence + '她穿过空荡荡的花房。');
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[2])).not.toContain(firstSentence);
    const sent = JSON.stringify(requests[3]);
    expect(requests[3]!.max_tokens).toBeLessThan(600);
    expect(sent.split(firstSentence).length).toBe(2);
    expect(sent).not.toContain('雨水落进旧井');
    expect(sent).not.toContain('这里是独立问题的回答');
  });

  test('implicit card creation creates six cards, a group and five edges locally without duplicates on follow-up', async ({ page }) => {
    const original = '创建一张世界观，一张能力，四张空白，空白打组，能力连接世界观，四张空白连接能力用虚线。';
    let round = 0;
    await page.route('https://api.deepseek.com/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      round++;
      return route.abort();
    });
    await configure(page, url, 'deepseek', 'deepseek-flash', 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
    };
    const cards = page.getByRole('article', { name: /文本节点：(世界观|能力|空白 [1-4])$/u });
    await send(original);
    await expect(cards).toHaveCount(6);
    await openControl(page);
    await expect(control).toContainText('已回读核对 12 项操作');
    await expect(page.locator('.group-frame')).toHaveCount(1);
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(4);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await expect(page.locator('.group-frame')).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(cards).toHaveCount(6);
    await send('还是没有');
    await expect(ai).toContainText('上次的 12 项操作已经在画布上应用');
    await expect(cards).toHaveCount(6);
    expect(round).toBe(0);
  });

  test('local language understanding creates both requested cards with zero model calls and chats in one request', async ({ page }) => {
    test.setTimeout(60000);
    let round = 0;
    await page.route('https://canvas-control.test/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      round++;
      const request=route.request().postDataJSON() as {tools?:Array<{function:{name:string}}>};
      expect(request.tools?.map(tool=>tool.function.name)??[]).not.toContain('begin_canvas_task');
      return route.fulfill({contentType:'text/event-stream',headers:{'access-control-allow-origin':'*'},body:`data: ${JSON.stringify({choices:[{delta:{content:'可以先讨论利弊，再决定是否调整。'}}]})}\n\ndata: [DONE]\n\n`});
    });
    await page.goto(url);
    await page.getByRole('region',{name:'Echo-8 书库'}).press('Escape');
    await page.getByRole('button',{name:/^打开 AI 助手/u}).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('造一个角色卡，一个人物卡');
    await ai.locator('.ai-composer textarea').press('Enter');
    const cards=page.getByRole('article',{name:/文本节点：(人物卡|角色卡)$/u});
    await expect(cards).toHaveCount(2,{timeout:30000});
    await expect(ai.getByRole('status')).toContainText('已直接完成 2 项操作');
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    expect(round).toBe(0);
    await page.getByRole('button',{name:'撤销',exact:true}).click();
    await expect(cards).toHaveCount(0);
    await page.getByRole('button',{name:'重做',exact:true}).click();
    await expect(cards).toHaveCount(2);
    await ai.locator('.ai-composer textarea').fill('选中角色卡和人物卡');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('已选中 2 个节点');
    await ai.locator('.ai-composer textarea').fill('把这两张都弄成蓝色');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 2 项操作');
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    await ai.getByRole('button',{name:'关闭AI 助手'}).click();
    await configure(page,url,'openai',undefined,'direct',false);
    await ai.locator('.ai-composer textarea').fill('这些想法值得继续讨论');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai).toContainText('可以先讨论利弊，再决定是否调整。');
    expect(round).toBe(1);
    await expect(cards).toHaveCount(2);
  });

  test('only checked preview items are applied and verified offline', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const ask = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
    };
    for (const [index, title] of ['甲项', '乙项', '丙项'].entries()) {
      await ask(`新建一个叫${title}的节点`);
      await expect(ai.getByLabel('本轮 Token 用量')).toHaveCount(index + 1);
    }
    await ask('把甲项改成蓝色，然后把乙项改成蓝色，再把丙项改成蓝色');
    const review = control.getByRole('region', { name: '画布操作计划', exact: true }).first();
    await expect(review.getByRole('checkbox')).toHaveCount(3);
    await control.getByRole('button', { name: '取消全选', exact: true }).click();
    await review.getByRole('checkbox', { name: '修改文字对象 · 甲项' }).check();
    await review.getByRole('checkbox', { name: '修改文字对象 · 丙项' }).check();
    await control.getByRole('button', { name: '应用选中的 2 项' }).click();
    await expect(review).toContainText('已回读核对 2 项操作');
    await expect(review).toContainText('修改文字对象 · 甲项');
    await expect(review).toContainText('修改文字对象 · 丙项');
    await expect(review).not.toContainText('修改文字对象 · 乙项');
  });

  test('a typo in a relative layout request uses current named cards and an exact gap after earlier canvas turns', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const ask = async (prompt: string) => {
      const replies = ai.locator('.ai-chat-bubble.assistant:not(.ai-streaming-response)');
      const count = await replies.count();
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(replies).toHaveCount(count + 1);
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    };
    for (const prompt of ['新建一张角色卡，叫人物卡', '新建一个叫武器卡的节点', '新建一个叫干扰卡的节点', '选中干扰卡']) {
      await ask(prompt);
      await expect(ai.getByRole('status')).toContainText(/已直接完成|已选中/u);
    }
    await ask('武器卡排列杂人物卡上方，中间空20PX');
    await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('修改文字对象 · 武器卡');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('已回读核对 1 项操作');
    const first = page.getByRole('article', { name: /文本节点：武器卡$/u });
    const second = page.getByRole('article', { name: /文本节点：人物卡$/u });
    const gap = async () => {
      const scale = await page.locator('.canvas-world').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
      const moving = (await first.boundingBox())!;
      const anchor = (await second.boundingBox())!;
      return (anchor.y - moving.y - moving.height) / scale;
    };
    // The renderer snaps both edges to device pixels. The geometry unit tests check exact world coordinates.
    await expect.poll(async () => Math.abs(await gap() - 20)).toBeLessThan(1.25);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ask('间距改成35');
    await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('修改文字对象 · 武器卡');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('已回读核对 1 项操作');
    await expect.poll(async () => Math.abs(await gap() - 35)).toBeLessThan(1.25);
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
  });

  test('DeepSeek writes a biography into a uniquely named blank card in one request', async ({ page }) => {
    const prompt = '在角色里设计一个人物小传';
    const text = '林渊在钟楼修表，始终留着父亲失踪那天停下的怀表。';
    let requests = 0;
    await page.route('https://api.deepseek.com/chat/completions', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests++;
      const request = route.request().postDataJSON() as { messages: Array<{ role: string; content: string }>; tools?: unknown[] };
      expect(request.tools).toBeUndefined();
      expect(request.messages.some(message => message.role === 'tool')).toBe(false);
      expect(request.messages.at(-1)?.content).toContain(prompt);
      const delta = { content: JSON.stringify({ text }) };
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'deepseek', 'deepseek-flash', 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const composer = ai.locator('.ai-composer textarea');
    const role = page.getByRole('article', { name: /文本节点：角色$/u });
    const person = page.getByRole('article', { name: /文本节点：人物$/u });
    await composer.fill('建一张角色，一张人物，四张空白卡');
    await composer.press('Enter');
    await expect(role).toBeVisible();
    await expect(person).toBeVisible();
    await expect(ai.getByRole('status')).toContainText('已直接完成 6 项');
    expect(requests).toBe(0);
    await composer.fill(prompt);
    await composer.press('Enter');
    await expect(role).toContainText(text);
    await expect(person).not.toContainText(text);
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项');
    expect(requests).toBe(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(role).toBeVisible();
    await expect(role).not.toContainText(text);
  });

  test('a named nonempty card continues in one request and preserves its previous paragraphs', async ({ page }) => {
    const oldText = '旧设定：来自钟楼，武器原先由城北的铜匠保管。';
    const newText = '新设定：用钟楼铜片铸成。';
    const fixture = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '模型协议回归' }),
      JSON.stringify({ type: 'node', id: 'weapon', category: '资料', name: '武器卡', text: oldText }),
      JSON.stringify({ type: 'node', id: 'other', category: '资料', name: '角色卡', text: '另一张卡。' }), JSON.stringify({ type: 'end' })].join('\n');
    let requests = 0;
    await page.route('https://api.deepseek.com/chat/completions', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests++;
      const request = route.request().postDataJSON() as { tools?: unknown[]; messages: Array<{ role: string; content: string }> };
      expect(request.tools).toBeUndefined();
      expect(request.messages.some(message => message.content.includes(oldText))).toBe(true);
      expect(request.messages.some(message => message.content.includes('另一张卡。'))).toBe(false);
      const delta = { content: JSON.stringify({ text: newText }) };
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).locator('input[type=file]').setInputFiles({ name: '模型协议.e8', mimeType: 'text/plain', buffer: Buffer.from(fixture) });
    await configure(page, url, 'deepseek', 'deepseek-flash', 'review', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('给武器卡续写一段它的来历');
    await ai.locator('.ai-composer textarea').press('Enter');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const card = page.getByRole('article', { name: /文本节点：资料｜武器卡$/u });
    await expect(control).toContainText('1 项操作');
    await expect(card).not.toContainText(newText);
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control).toContainText('已回读核对 1 项操作');
    await expect(card).toContainText(oldText);
    await expect(card).toContainText(newText);
    expect(requests).toBe(1);
  });

  test('bound summaries, field batches and range rewrites each write through one request', async ({ page }) => {
    const book = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '已绑定写入回归' }),
      JSON.stringify({ type: 'node', id: 'a', category: '人物组', name: '甲卡', text: '甲住钟楼。\n动机：' }),
      JSON.stringify({ type: 'node', id: 'b', category: '人物组', name: '乙卡', text: '乙在修桥。' }),
      JSON.stringify({ type: 'node', id: 'c', category: '人物组', name: '丙卡', text: '丙守城门。\n动机：保卫家园' }),
      JSON.stringify({ type: 'node', id: 'out', category: '资料', name: '总览卡', text: '保留第一段。\n\n保留第三段前的原段。\n\n保留第三段。' }),
      JSON.stringify({ type: 'end' })].join('\n');
    const replies = [{ text: '三人各自守护不同地点。' }, { texts: ['追查钟声', '让乡亲过河'] }, { text: '第二段改写为简报。' }];
    let requests = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const request = route.request().postDataJSON() as { tools?: unknown; messages: Array<{ content: string }> };
      expect(request.tools).toBeUndefined();
      const evidence = request.messages.map(message => message.content).join('\n');
      if (requests === 0) for (const fact of ['甲住钟楼。', '乙在修桥。', '丙守城门。']) expect(evidence).toContain(fact);
      if (requests === 1) {
        expect(evidence).toContain('甲住钟楼。');
        expect(evidence).toContain('乙在修桥。');
        expect(evidence).not.toContain('丙守城门。');
      }
      const delta = { content: JSON.stringify(replies[requests++]) };
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).locator('input[type=file]').setInputFiles({ name: '写入.e8', mimeType: 'text/plain', buffer: Buffer.from(book) });
    await configure(page, url, 'openai', undefined, 'review', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const output = page.getByRole('article', { name: /文本节点：资料｜总览卡$/u });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
    };
    const apply = async (count: number) => {
      await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText(`${count} 项操作`);
      await control.getByRole('button', { name: '应用整份计划' }).click();
      await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText(`已回读核对 ${count} 项操作`);
      await control.getByRole('button', { name: '关闭画布控制' }).click();
    };
    await send('选中甲卡、乙卡和丙卡');
    await expect(ai.getByRole('status')).toContainText('已选中 3 个节点');
    await send('总结这三张卡，把结果写进总览卡');
    await apply(1);
    expect(requests).toBe(1);
    await expect(output).toContainText('三人各自守护不同地点。');
    await expect(output).toContainText('保留第一段。');
    await send('给人物组里缺动机的卡补上动机');
    await apply(2);
    expect(requests).toBe(2);
    await expect(page.getByRole('article', { name: /文本节点：人物组｜甲卡$/u })).toContainText('追查钟声');
    await expect(page.getByRole('article', { name: /文本节点：人物组｜乙卡$/u })).toContainText('让乡亲过河');
    await expect(page.getByRole('article', { name: /文本节点：人物组｜丙卡$/u })).toContainText('保卫家园');
    await send('@画布操作 @[资料｜总览卡] 改写第2段，保留其他段落。');
    await apply(1);
    expect(requests).toBe(3);
    await expect(output).toContainText('第二段改写为简报。');
    await expect(output).toContainText('保留第三段。');
    await expect(output).not.toContainText('保留第三段前的原段。');
  });

  test('unresolved narrative requests use the current model and a clarification never produces partial writes', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls++;
      return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ actions: [], clarification: '请补充人物资料和创建方式。' }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 10 } }, headers: { 'access-control-allow-origin': '*' } });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const before = await page.locator('.text-node-card').count();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('让画布里出现一位等待第十三声钟的修钟学徒，写好他的资料。');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText(/本地|补充|说明|不能可靠/u);
    await expect(page.locator('.text-node-card')).toHaveCount(before);
    expect(calls).toBe(1);
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 30 · 输出 10');
  });

  test('a rejecting model endpoint cannot interfere with a complete local canvas command', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => { calls++; return route.fulfill({ status: 400, body: 'tools unsupported' }); });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill(LOCAL_MIXED_GRAPH);
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 6 项');
    await expect(page.locator('.group-frame')).toHaveCount(1);
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
    expect(calls).toBe(0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.group-frame')).toHaveCount(0);
  });

  test('missing descriptive targets stay local and an exact follow-up can rename the real card', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => { calls++; return route.abort(); });
    await seedCanvas(page, url, [{ title: '倾听者', body: '站在钟楼下偷听消息。' }]);
    await configure(page, url, 'openai', undefined, 'review', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('把钟楼下偷听的那张卡改名为聆听者');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('没有找到');
    await expect(page.getByRole('article', { name: /文本节点：倾听者$/u })).toHaveCount(1);
    await ai.locator('.ai-composer textarea').fill('把倾听者改名为聆听者');
    await ai.locator('.ai-composer textarea').press('Enter');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control).toContainText('1 项操作');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(page.getByRole('article', { name: /文本节点：聆听者$/u })).toContainText('钟楼下偷听');
    expect(calls).toBe(0);
  });

  test('reported all-node layouts run offline without selection and log scope, counts and commit states', async ({ page }) => {
    const book = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '全画布排列验收' }),
      ...Array.from({ length: 6 }, (_, index) => JSON.stringify({ type: 'node', id: 'layout-' + index, category: '对象', name: '节点' + (index + 1), text: '' })),
      JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '全画布排列.e8', mimeType: 'text/plain', buffer: Buffer.from(book) });
    await expect(library).toHaveCount(0);
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    for (const prompt of ['垂直排列所有节点', '@画布操作 宫格排列所有节点', '水平排列节点']) {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('7 项操作');
      await expect(ai.getByRole('status')).toContainText('应用整份计划');
      await control.getByRole('button', { name: '应用整份计划' }).click();
      await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('已应用');
      await expect(ai.getByRole('status')).toContainText('已在画布应用 7 项操作');
      await control.getByRole('button', { name: '关闭画布控制' }).click();
    }
    await ai.getByRole('button', { name: '打开实时操作日志', exact: true }).click();
    const log = page.getByRole('region', { name: '实时操作日志', exact: true });
    await expect(log).toContainText('本地执行规则');
    await expect(log).toContainText('命中 7 个对象');
    await expect(log).toContainText('更新节点 7 项');
    await expect(log).toContainText('修改已提交到画布，可撤销');
    await log.getByText('步骤与执行详情', { exact: true }).first().click();
    await expect(log).toContainText('提交修改');
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText(Array(3).fill('本轮 Token：输入 0 · 输出 0'));
  });

  test('reported character-card writing binds the actual node and puts generated content into its reviewed plan', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls += 1;
      const request = route.request().postDataJSON() as { messages: Array<{ role: string; content: string }> };
      if (request.messages.some(message => message.role === 'system' && message.content.includes('应用已核对本轮写入目标和范围'))) {
        const content = JSON.stringify({ text: '姓名：沈无咎\n任务：了结祖父最后一笔未还的愿。' });
        return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
          body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
      }
      const directory = request.messages.find(message => message.content.startsWith('<untrusted-canvas-objects>'))?.content ?? '';
      const nodes = (JSON.parse(/<untrusted-canvas-objects>\n(.+)\n<\/untrusted-canvas-objects>/u.exec(directory)![1]!) as { nodes: Array<{ id: string; title: string }> }).nodes;
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.title).toBe('资料｜角色卡');
      expect(request.messages.some(message => message.role === 'system' && message.content.includes('当前应用已经提供真实画布操作通道'))).toBe(true);
      const content = JSON.stringify(calls === 1 ? { version: 1, actions: [], answer: '我没有画布写入能力，请自行粘贴。' } :
        { version: 1, actions: [{ type: 'update-node', id: nodes[0]!.id, text: '姓名：沈无咎\n任务：了结祖父最后一笔未还的愿。' }] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    const book = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '角色卡写入验收' }),
      JSON.stringify({ type: 'node', id: 'role', category: '资料', name: '角色卡', text: '姓名：\n任务：' }),
      JSON.stringify({ type: 'node', id: 'other', category: '地点', name: '地图', text: '不改动地图正文' }), JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '角色卡写入.e8', mimeType: 'text/plain', buffer: Buffer.from(book) });
    await expect(library).toHaveCount(0);
    await configure(page, url, 'openai', undefined, 'review', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    for (const prompt of ['在角色卡里设计人物', '@画布操作 在角色卡节点里，设计人物']) {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.locator('.ai-composer textarea').press('Enter');
      const control = page.getByRole('region', { name: '画布控制', exact: true });
      await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('资料｜角色卡');
      await control.getByRole('button', { name: '应用整份计划' }).click();
      await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('已应用');
      await control.getByRole('button', { name: '关闭画布控制' }).click();
    }
    await ai.locator('.ai-composer textarea').fill('在角色节点里，设计任务');
    await ai.locator('.ai-composer textarea').press('Enter');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const candidates = control.getByRole('region', { name: '选择「角色节点」', exact: true });
    await expect(candidates.getByRole('button')).toHaveCount(1);
    expect(calls).toBe(2);
    await candidates.getByRole('button').click();
    await expect(control.getByRole('button', { name: '应用整份计划' })).toBeVisible();
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('已应用');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    expect(calls).toBe(3);
    await ai.getByRole('button', { name: '关闭AI 助手', exact: true }).click();
    await expect(page.getByRole('article', { name: /文本节点：资料｜角色卡$/u })).toContainText('沈无咎');
    await expect(page.getByRole('article', { name: /文本节点：地点｜地图$/u })).toContainText('不改动地图正文');
  });

  test('creating a character card uses the canvas offline and respects review mode', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const card = page.getByRole('article', { name: /文本节点：角色卡$/u });
    const send = async (prompt: string) => {
      const composer = ai.locator('.ai-composer textarea');
      await composer.fill(prompt);
      await composer.press('Enter');
    };
    await send('创建一张角色卡');
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项操作');
    await expect(card).toContainText('姓名：');
    await expect(card).toContainText('人物关系：');
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(card).toBeVisible();

    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await palette.getByRole('textbox', { name: '搜索命令' }).fill('画布控制');
    await palette.getByRole('option', { name: /^画布控制/u }).click();
    await control.getByRole('combobox', { name: '画布生成方式' }).selectOption('review');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await send('帮我建一张人物卡，叫「沈砚」');
    await expect(ai.getByRole('status')).toContainText('应用整份计划');
    const named = page.getByRole('article', { name: /文本节点：沈砚$/u });
    await expect(named).toHaveCount(0);
    await expect(control).toContainText('新建文字节点 · 沈砚');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('button', { name: '应用整份计划' })).toHaveCount(0);
    await expect(control).toContainText('已应用');
  });

  test('real-time operation log distinguishes model wait, pending review, application and undo', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('https://canvas-control.test/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      if (route.request().postData()?.includes('private-model-failure-724')) {
        return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ error: { message: 'private-provider-error-724' } }) });
      }
      await held;
      const content = JSON.stringify({ texts: ['private-node-body-724'] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const log = page.getByRole('region', { name: '实时操作日志', exact: true });
    const row = (label: string) => log.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
    try {
      await ai.locator('.ai-composer textarea').fill('新建一个叫日志测试节点的节点，并写一段关于 private-prompt-724 的正文');
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
      await ai.getByRole('button', { name: '打开实时操作日志', exact: true }).click();
      await expect(row('模型响应')).toContainText('等待模型响应');
      await expect(row('AI 生成')).toContainText('单次时限');
    } finally { release(); }
    const card = page.getByRole('article', { name: /文本节点：日志测试节点$/u });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(row('模型响应')).toContainText('响应延迟');
    await expect(row('AI 画布计划')).toContainText('待确认');
    await row('AI 画布计划').getByRole('button', { name: '查看同轮' }).click();
    await expect(row('准备 AI 上下文')).toBeVisible();
    await expect(row('模型响应')).toBeVisible();
    await log.getByRole('button', { name: '清除同轮筛选' }).click();
    await expect(card).toHaveCount(0);
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(row('AI 画布计划')).toContainText('已应用');
    await expect(row('提交 AI 画布修改')).toContainText('已应用');
    await expect(log).not.toContainText(/private-(?:node-body|prompt)-724/u);
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: /^撤销/u }).click();
    await expect(row('撤销画布修改')).toContainText('已应用');
    await expect(card).toHaveCount(0);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await log.getByRole('combobox', { name: '筛选操作日志' }).selectOption('issues');
    await expect(row('AI 画布计划')).toHaveCount(0);
    await ai.locator('.ai-composer textarea').fill('新建一个测试节点，并写一段关于 private-model-failure-724 的正文');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(row('模型响应')).toContainText('失败');
    await expect(log).not.toContainText('private-provider-error-724');
  });

  test('natural character creation keeps the local title and requests only background prose', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls++;
      const request = route.request().postDataJSON() as { tools?: unknown; messages: Array<{ content: string }> };
      expect(request.tools).toBeUndefined();
      expect(JSON.stringify(request.messages)).toContain('不要调用画布工具或输出操作计划');
      const content = JSON.stringify({ texts: ['夜班测绘员。'] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('创建一张角色卡，并为她写一段背景故事');
    await ai.locator('.ai-composer textarea').press('Enter');
    const card = page.getByRole('article', { name: /文本节点：角色卡$/u });
    await expect(card).toContainText('夜班测绘员。');
    expect(calls).toBe(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(card).toHaveCount(0);
  });

  test('mixed text and canvas operations show one preview and undo together', async ({ page }) => {
    await seedCanvas(page, url, [{ title: '混合甲' }, { title: '混合乙', body: '已有介绍。' }, { title: '混合丙' }]);
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      calls++;
      const request = route.request().postDataJSON() as { tools?: unknown; messages: Array<{ content: string }> };
      expect(request.tools).toBeUndefined();
      expect(JSON.stringify(request.messages)).not.toMatch(/删除|混合丙|甲的新标题|已有介绍/u);
      const content = JSON.stringify({ texts: ['夜间巡查员。'] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct', false);
    const assistant = page.getByRole('region', { name: 'AI 助手', exact: true });
    await assistant.locator('.ai-composer textarea').fill('把混合甲的标题改成「甲的新标题」，在混合乙里写一段介绍，把混合甲连到混合乙，最后删除混合丙');
    await assistant.locator('.ai-composer textarea').press('Enter');
    const canvas = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(canvas.getByText('4 项操作', { exact: true })).toBeVisible({ timeout: 12_000 });
    const a = page.getByRole('article', { name: '文本节点：甲的新标题', exact: true });
    const b = page.getByRole('article', { name: '文本节点：混合乙', exact: true });
    const c = page.getByRole('article', { name: '文本节点：混合丙', exact: true });
    await expect(c).toHaveCount(1);
    await canvas.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await expect(a).toBeVisible();
    await expect(b).toContainText('夜间巡查员。');
    await expect(c).toHaveCount(0);
    expect(calls).toBe(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(c).toHaveCount(1);
    await expect(a).toHaveCount(0);
    await expect(b).not.toContainText('夜间巡查员。');
  });

  test('formal natural memory is reviewed and recorded offline', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('记住主角年龄：29');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const review = ai.getByRole('dialog', { name: '需要确认的上下文检查' });
    await expect(review).toContainText('@确认 主角年龄：29');
    await review.getByRole('button', { name: '确认并继续' }).click();
    await expect(ai).toContainText('已确认并记入当前对话。');
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
  });

  test('named comparison sends both sources and saves the result only after confirmation', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      if (calls === 1) {
        const wire = request.messages.map(message => message.content).join('\n');
        expect(wire).toContain('出生于渡口。');
        expect(wire).toContain('出生于港城。');
      }
      const content = '两稿的出生地不同。';
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await seedCanvas(page, url, [{ title: '初稿', body: '出生于渡口。' }, { title: '终稿', body: '出生于港城。' }]);
    await configure(page, url, 'openai', undefined, 'direct', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await send('对比初稿和终稿，并把冲突整理成名为「人物冲突」的新节点');
    const card = page.getByRole('article', { name: '文本节点：人物冲突' });
    const review = ai.getByRole('dialog', { name: '新建结果节点确认' });
    await expect(review).toContainText('两稿的出生地不同。');
    await expect(card).toHaveCount(0);
    await review.getByRole('button', { name: '创建节点' }).click();
    await expect(card).toContainText('两稿的出生地不同。');
    expect(calls).toBe(1);
  });

  test('retrieval settings are governed, show honest versions and retain mode without a model connection', async ({ page }, info) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await openModelSettings(page);
    await page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true }).getByRole('button', { name: '打开检索设置', exact: true }).click();
    const settings = page.getByRole('region', { name: '检索设置', exact: true });
    const mode = settings.getByRole('combobox', { name: '检索方式', exact: true });
    await expect(mode).toHaveValue('local');
    await mode.selectOption('keyword');
    await expect(settings).toContainText('本轮自动检索跳过语义模型');
    await settings.getByText('关键词索引版本与更新', { exact: true }).click();
    await settings.getByText('本地模型版本、优点与代价', { exact: true }).click();
    await expect(settings).toContainText('Xenova/bge-small-zh-v1.5');
    const model = settings.getByRole('combobox', { name: '本地语义模型' });
    await expect(model).toHaveValue('small');
    await model.selectOption('base');
    await expect(settings).toContainText('Xenova/bge-base-zh-v1.5');
    await model.selectOption('small');
    await expect(settings).toContainText('前五均命中 12/12');
    await settings.screenshot({ path: info.outputPath('retrieval-settings.png') });
    await settings.getByRole('button', { name: '关闭检索设置' }).click();
    await openModelSettings(page);
    await page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true }).getByRole('button', { name: '打开检索设置', exact: true }).click();
    await expect(mode).toHaveValue('keyword');
    await mode.selectOption('cloud-fallback');
    await expect(settings).toContainText('云端连接仍需独立授权');
  });
  test('keyword canvas filters resolve and move the same local result set with zero model calls', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => { calls++; return route.abort(); });
    await seedCanvas(page, url, [{ title: '渡口账本', body: '旧案记录。' }, { title: '无关测试', body: '晴天。' }]);
    await configure(page, url, 'openai', undefined, 'review', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await ai.locator('.ai-composer textarea').fill('把跟旧案有关、但还没归类的线索整理出来');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(control.getByRole('button', { name: '渡口账本', exact: true })).toBeVisible();
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ai.locator('.ai-composer textarea').fill('把它们移到右边');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(control).toContainText('修改文字对象 · 渡口账本');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    expect(calls).toBe(0);
  });

  test('a described paragraph is rewritten in place and a short follow-up uses the applied text', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      if (calls >= 1) {
        const wire = request.messages.map(message => message.content).join('\n');
        expect(wire).toContain(calls === 1 ? '左腕有一道旧伤，阴天时会痛。' : '旧伤遇潮便痛。');
        expect(wire).not.toContain('远处绝不应发送');
        if (calls === 2) expect(wire).toContain('不要修改人物年龄');
      }
      const content = calls === 1 ? '旧伤遇潮便痛。' : '旧伤畏潮。';
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await seedCanvas(page, url, [{ title: '旧伤验收', body: '前文保留。\n\n左腕有一道旧伤，阴天时会痛。\n\n后文保留。' + '隔'.repeat(400) + '远处绝不应发送' }]);
    await configure(page, url, 'openai', undefined, 'direct', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await send('把旧伤验收里写旧伤的那段缩短一点，保留我的口吻，不要修改人物年龄。');
    await expect(ai.getByRole('button', { name: '接受提案', exact: true })).toBeVisible();
    await send('替换进去');
    const card = page.getByRole('article', { name: /文本节点：旧伤验收$/u });
    await expect(card).toContainText('旧伤遇潮便痛。');
    await send('再短一点，保留我的口吻。');
    await ai.getByRole('button', { name: '接受提案', exact: true }).click();
    await expect(card).toContainText('旧伤畏潮。');
    await expect(card).toContainText('前文保留。');
    await expect(card).toContainText('后文保留。');
    expect(calls).toBe(2);
  });
  test('natural group follow-up, bulk presentation and background use local reviewed changes', async ({ page }) => {
    const body = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '分组与背景验收' }),
      ...['林渊', '旧枪', '记者'].map((name, index) => JSON.stringify({ type: 'node', id: `n${index}`, category: `分类${index}`, name, text: `保留原文${index}` })), JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '分组与背景.e8', mimeType: 'text/plain', buffer: Buffer.from(body) });
    await expect(library).toHaveCount(0);
    const titles = await page.locator('.text-node-card header strong').allTextContents();
    const first = titles.find(title => title.includes('林渊'))!, second = titles.find(title => title.includes('旧枪'))!, third = titles.find(title => title.includes('记者'))!;
    expect([first, second, third].every(Boolean)).toBe(true);
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    const apply = async () => {
      await control.getByRole('button', { name: '应用整份计划' }).click();
      await expect(control.getByRole('button', { name: '应用整份计划' })).toHaveCount(0);
      await control.getByRole('button', { name: '关闭画布控制' }).click();
    };
    for (const category of ['分类0', '分类1', '分类2']) {
      await send(`解组${category}`);
      await expect(control).toContainText('1 项待应用');
      await apply();
    }
    await send('麻烦把林渊和旧枪组成一个群组，名为第一章线索');
    await expect(control).toContainText('新建群组 · 第一章线索');
    await apply();
    await send(`把${third}也加进去`);
    await expect(control).toContainText('修改群组 · 第一章线索');
    await apply();
    await send('把第一章线索里的节点切成文本框，标题改深蓝');
    await expect(control).toContainText('3 项待应用');
    await apply();
    await expect(page.getByRole('article', { name: /文本框：分类\d｜(?:林渊|旧枪|记者)$/u })).toHaveCount(3);
    await send('把背景色改成暖灰');
    await expect(control.getByLabel('画布背景预览')).toContainText('#b8afa4');
    await control.getByRole('button', { name: '应用背景', exact: true }).click();
    await expect(control.getByLabel('画布背景预览')).toHaveCount(0);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText(Array(7).fill('本轮 Token：输入 0 · 输出 0'));
  });
  test('flexible arrangement uses a local default gap without sending a title directory', async ({ page }) => {
    let requests = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      requests += 1;
      const body = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      const directory = body.messages.find(message => message.content.startsWith('<untrusted-canvas-objects>'))?.content ?? '';
      const nodes = (JSON.parse(/<untrusted-canvas-objects>\n(.+)\n<\/untrusted-canvas-objects>/u.exec(directory)![1]!) as { nodes: Array<{ id: string; title: string }> }).nodes;
      expect(nodes.map(node => node.title).sort()).toEqual(['人物｜林渊', '物件｜旧枪']);
      expect(JSON.stringify(body.messages)).not.toContain('不发送的地图正文');
      const content = JSON.stringify({ version: 1, actions: nodes.map((node, index) => ({ type: 'update-node', id: node.id, x: 400 + index * 440, y: 300 })) });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    const book = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '弹性画布模型' }),
      JSON.stringify({ type: 'node', id: 'hero', category: '人物', name: '林渊', text: '人物正文' }),
      JSON.stringify({ type: 'node', id: 'weapon', category: '物件', name: '旧枪', text: '物件正文' }),
      JSON.stringify({ type: 'node', id: 'map', category: '地点', name: '地图', text: '不发送的地图正文' }), JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '弹性画布模型.e8', mimeType: 'text/plain', buffer: Buffer.from(book) });
    await expect(library).toHaveCount(0);
    await configure(page, url, 'openai', undefined, 'review', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('把林渊和旧枪摆整齐些，两张卡片之间留白');
    await ai.locator('.ai-composer textarea').press('Enter');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control).toContainText('2 项操作');
    await expect(control).toContainText('等待确认');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control).toContainText('已应用');
    expect(requests).toBe(0);
  });

  test('natural canvas follow-ups use a newly created node and clarify partial titles offline', async ({ page }) => {
    const body = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '连续画布操作' }),
      JSON.stringify({ type: 'node', id: 'map', category: '地点', name: '北城地图', text: '' }),
      JSON.stringify({ type: 'node', id: 'south', category: '地点', name: '南城地图', text: '' }), JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '连续画布操作.e8', mimeType: 'text/plain', buffer: Buffer.from(body) });
    await expect(library).toHaveCount(0);
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const status = ai.getByRole('status');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string) => {
      const composer = ai.locator('.ai-composer textarea');
      await composer.fill(prompt);
      await composer.press('Enter');
    };
    await send('建个文本框，就叫线索');
    await expect(status).toContainText('已直接完成 1 项');
    await expect(page.getByText('线索', { exact: true }).first()).toBeVisible();
    await send('给线索用虚线连线');
    await expect(status).toContainText('要把「线索」连到哪个节点');
    await send('再连到地图');
    const choices = control.getByRole('region', { name: '选择「地图」' });
    await expect(choices.getByRole('button')).toHaveCount(2);
    await expect(page.locator('.connection-path:not(.draft)')).toHaveCount(0);
    await choices.getByRole('button', { name: /北城地图/u }).click();
    await expect(control).toContainText('连接 · 线索 → 地点｜北城地图');
    await expect(control).toContainText('已应用');
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await send('把刚才创建的线索刷成墨绿');
    await expect(status).toContainText('应用整份计划');
    await expect(control).toContainText('#235347');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('button', { name: '应用整份计划' })).toHaveCount(0);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText(Array(4).fill('本轮 Token：输入 0 · 输出 0'));
  });

  test('natural named connection and follow-ups reuse the preview and work offline without a model', async ({ page }) => {
    const body = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '自然语言操作验收' }),
      JSON.stringify({ type: 'node', id: 'hero', category: '主角', name: '林渊', text: '年龄：29。' }),
      JSON.stringify({ type: 'node', id: 'weapon', category: '武器', name: '旧枪', text: '' }), JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '自然语言操作.e8', mimeType: 'text/plain', buffer: Buffer.from(body) });
    await expect(library).toHaveCount(0);
    const nodeTitles = await page.locator('.text-node-card header strong').allTextContents();
    const hero = nodeTitles.find(title => title.includes('林渊'))!;
    const weapon = nodeTitles.find(title => title.includes('旧枪'))!;
    expect(hero).toBeTruthy(); expect(weapon).toBeTruthy();
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const reviews = control.getByRole('region', { name: '画布操作计划', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await page.context().setOffline(true);
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await palette.getByRole('textbox', { name: '搜索命令' }).fill('画布控制');
    await palette.getByRole('option', { name: /^画布控制/u }).click();
    await control.getByRole('combobox', { name: '画布生成方式' }).selectOption('review');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await send('帮我找到林渊');
    await expect(ai).toContainText(`找到「${hero}」，已在画布定位。`);
    await send('帮我把旧枪连到林渊');
    await expect(reviews).toHaveCount(1);
    await expect(reviews.first()).toContainText(`连接 · ${weapon} → ${hero}`);
    await expect(reviews.first()).toContainText('线型 · 实线');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await send('用虚线');
    await expect(reviews).toHaveCount(1);
    await expect(reviews.first()).toContainText(`连接 · ${weapon} → ${hero}`);
    await expect(reviews.first()).toContainText('线型 · 虚线');
    await expect(page.locator('.connection-path:not(.draft)')).toHaveCount(0);
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await send('改回实线');
    await expect(reviews.first()).toContainText(`修改连线 · ${weapon} → ${hero}`);
    await expect(reviews.first()).toContainText('线型 · 实线');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(0);
    await expect(page.locator('.connection-path:not(.draft)')).toHaveCount(1);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText(Array(4).fill('本轮 Token：输入 0 · 输出 0'));
  });
  test('natural connecting draws offline from named endpoints and from selection, and undoes in one step', async ({ page }) => {
    const body = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '自然连线验收' }),
      JSON.stringify({ type: 'node', id: 'hero', category: '人物', name: '主角', text: '' }),
      JSON.stringify({ type: 'node', id: 'weapon', category: '物件', name: '武器', text: '' }),
      JSON.stringify({ type: 'node', id: 'map', category: '物件', name: '地图', text: '' }), JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '自然连线.e8', mimeType: 'text/plain', buffer: Buffer.from(body) });
    await expect(library).toHaveCount(0);
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await page.context().setOffline(true);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const status = ai.getByRole('status');
    const lines = page.locator('.connection-path:not(.draft)');
    const send = async (prompt: string) => {
      const composer = ai.locator('.ai-composer textarea');
      await composer.fill(prompt);
      await composer.press('Enter');
    };
    await send('把主角和武器连起来');
    await expect(status).toContainText('已连线 · 人物｜主角 → 物件｜武器（实线）');
    await expect(lines).toHaveCount(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(lines).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(lines).toHaveCount(1);
    await send('把武器和主角连起来');
    await expect(status).toContainText('人物｜主角 → 物件｜武器」已有实线');
    await expect(lines).toHaveCount(1);
    await send('连接不存在的节点和主角');
    await expect(status).toContainText('没有找到名为「不存在的节点」');
    await expect(lines).toHaveCount(1);
    await send('选中主角和地图');
    await expect(page.locator('.text-node-card.selected')).toHaveCount(2);
    await send('用虚线连线');
    await expect(status).toContainText('已连线 · 人物｜主角 → 物件｜地图（虚线）');
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
    await expect(lines).toHaveCount(2);
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
  });

  test('offline duplicate-name choices resume the requested direction and keep the chosen endpoint', async ({ page }) => {
    const body = [JSON.stringify({ type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1, title: '同名点选验收' }),
      JSON.stringify({ type: 'node', id: 'hero', category: '主角', name: '林渊', section: '人物', text: '现行版本。' }),
      JSON.stringify({ type: 'node', id: 'old-hero', category: '主角', name: '林渊 2', section: '废稿', text: '旧版。' }),
      JSON.stringify({ type: 'node', id: 'weapon', category: '武器', name: '旧枪', text: '' }), JSON.stringify({ type: 'end' })].join('\n');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '同名点选.e8', mimeType: 'text/plain', buffer: Buffer.from(body) });
    await expect(library).toHaveCount(0);
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await page.context().setOffline(true);
    await send('把武器｜旧枪和主角｜林渊用虚线连起来');
    const choices = control.getByRole('region', { name: '选择「主角｜林渊」' });
    await expect(choices.getByRole('button')).toHaveCount(2);
    await expect(page.locator('.connection-path:not(.draft)')).toHaveCount(0);
    await choices.getByRole('button', { name: /废稿/u }).click();
    await expect(choices).toHaveCount(0);
    const reviews = control.getByRole('region', { name: '画布操作计划', exact: true });
    await expect(reviews).toHaveCount(1);
    await expect(reviews).toContainText('已应用');
    await expect(reviews).toContainText(/连接 · 武器｜旧枪 → 主角｜林渊 2/u);
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText('本轮 Token：输入 0 · 输出 0');
  });
  test('a named canvas query finds the protagonist and a short follow-up changes the real weapon line without model calls', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      const content = calls === 1 ? { version: 1, actions: [
        { type: 'create-node', ref: 'hero', title: '测试主角', text: '仅作原文的角色设定。' },
        { type: 'create-node', ref: 'weapon', title: '测试武器' },
        { type: 'create-connection', ref: 'insert', from: 'hero', to: 'weapon', line: 'solid' },
      ] } : { version: 1, actions: [], answer: '找到了测试主角。' };
      if (calls === 2) {
        const directory = request.messages.find(message => message.content.startsWith('<untrusted-canvas-objects>'))?.content ?? '';
        expect(directory).toContain('测试主角');
        expect(directory).not.toContain('仅作原文的角色设定');
      }
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await send('@画布操作 创建一张「测试主角」，一张「测试武器」，「测试主角」连接到「测试武器」');
    await expect(ai.getByRole('status')).toContainText('已直接完成 3 项');
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    await page.getByRole('article', { name: /文本节点：测试武器$/u }).click({ position: { x: 20, y: 70 } });
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await send('@画布操作 查找测试主角');
    await expect(ai.getByRole('log')).toContainText('找到「测试主角」');
    await send('@画布操作 插入是用虚线');
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control).toContainText('线型 · 虚线');
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    expect(calls).toBe(0);
    await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(0);
  });
  test('designing a protagonist fills the selected blank node directly and undo restores the blank node', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      expect(JSON.stringify(request.messages)).toContain('不要调用画布工具或输出操作计划');
      const content = { text: '林渊在夜里修表，害怕钟声。' };
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    for (const prompt of ['@画布操作 新建一个叫待设计主角的节点', '@画布操作 设计主角']) {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
      await expect(ai.getByRole('status')).toContainText('已直接完成 1 项');
    }
    const node = page.getByRole('article', { name: /文本节点：待设计主角$/u });
    await expect(node).toContainText('林渊在夜里修表，害怕钟声。');
    await expect(page.getByRole('region', { name: '画布控制', exact: true })).toHaveCount(0);
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(node).toBeVisible();
    await expect(node).not.toContainText('林渊在夜里修表');
    expect(calls).toBe(1);
  });
  test('paragraph rewrite sends a bound range and applies only the replacement with one undo', async ({ page }) => {
    test.setTimeout(60_000);
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      if (calls === 1) {
        const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
        const target = request.messages.find(message => message.content.startsWith('本轮正文目标'))?.content;
        expect(target).toContain('"start":8'); expect(target).toContain('"end":14');
        expect(request.messages.some(message => message.content.includes('第二段原文。'))).toBe(true);
      }
      const content = '第二段的新表达。';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n` });
    });
    await seedCanvas(page, url, [{ title: '段落目标', body: '第一段保留。\n\n第二段原文。\n\n第三段保留。' }]);
    await configure(page, url, 'openai', undefined, 'direct', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@改写 @[段落目标] 修改第2段，保留其他段落。');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai.getByRole('combobox', { name: 'AI 提案写入方式' })).toHaveValue('replace', { timeout: 25_000 });
    await expect(ai.getByRole('combobox', { name: 'AI 提案写入方式' })).toContainText('替换已定位范围');
    await ai.getByRole('button', { name: '接受提案', exact: true }).click();
    const node = page.getByRole('article', { name: /文本节点：段落目标$/u });
    await expect(node).toContainText('第一段保留。'); await expect(node).toContainText('第二段的新表达。'); await expect(node).toContainText('第三段保留。');
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(node).toContainText('第二段原文。'); await expect(node).not.toContainText('第二段的新表达。');
    expect(calls).toBe(1);
  });
  test('native role follow-ups retain constraints and task totals separate new tasks from retries', async ({ page }) => {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: requests.length === 1 ? '已保留人物限制。' : '他害怕钟声，不能复活。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50 } })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (text: string, replies: number) => {
      await ai.locator('.ai-composer textarea').fill(text);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
      await expect(ai.getByLabel('本轮 Token 用量')).toHaveCount(replies);
    };
    await send('主角林渊害怕钟声。禁止赋予复活能力。', 1);
    await send('他害怕什么？保留刚才的限制。', 2);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.some(message => message.role === 'assistant' && message.content === '已保留人物限制。')).toBe(true);
    expect(requests[1]!.messages.filter(message => message.content.includes('主角林渊害怕钟声。禁止赋予复活能力。'))).toHaveLength(1);
    const task = ai.getByLabel('任务累计 Token 用量', { exact: true });
    await task.locator(':scope > summary').click();
    await expect(task).toContainText('平台返回：输入 200 · 输出 40');
    await expect(task).toContainText('缓存命中 100');
    await ai.screenshot({ path: test.info().outputPath('task-usage-expanded.png') });
    await task.getByRole('button', { name: '新任务', exact: true }).click();
    await send('你好', 3);
    await expect(task).toContainText('平台返回：输入 100 · 输出 20');
    await task.getByRole('combobox', { name: '查看任务用量' }).selectOption({ label: '任务 1' });
    await expect(task).toContainText('平台返回：输入 200 · 输出 40');
  });
  test('explicit selected-node recolor makes no model call, remains reviewed and undoes normally', async ({ page }) => {
    let requests = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests += 1;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ version: 1, actions: [{ type: 'create-node', ref: 'hero', title: '本地改色目标', text: '原文必须保留。', color: '#a83d44' }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n` });
    });
    await seedCanvas(page, url, [{ title: '本地改色目标', body: '原文必须保留。', color: '#a83d44' }]);
    await configure(page, url, 'openai', undefined, 'direct', false);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('选中本地改色目标');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai.getByRole('status')).toContainText('已选中 1 个节点');
    await ai.locator('.ai-composer textarea').fill('@画布操作 把选中节点设为 #336699');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control.getByText('1 项操作', { exact: true }).first()).toBeVisible();
    expect(requests).toBe(0);
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    const card = page.getByRole('article', { name: /文本节点：本地改色目标$/u });
    await expect(card.locator('header')).toHaveCSS('background-color', 'rgb(51, 102, 153)');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(card.locator('header')).toHaveCSS('background-color', 'rgb(32, 33, 36)');
    await expect(card).toContainText('原文必须保留。');
  });
  test('new objects generate directly by default and one undo reverses the whole generated batch', async ({ page }) => {
    await page.route('https://canvas-control.test/**', route => route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      : route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` }));
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill(LOCAL_MIXED_GRAPH);
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai.getByRole('status')).toContainText('已直接完成 6 项');
    await expect(page.getByRole('region', { name: '画布控制', exact: true })).toHaveCount(0);
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    const hero = page.getByRole('article', { name: /文本节点：主角｜林渊$/u });
    await expect(hero).toBeVisible();
    await expect(page.locator('.group-frame')).toHaveCount(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(hero).toHaveCount(0); await expect(page.locator('.group-frame')).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(hero).toBeVisible();
  });
  test('a 17-operation review scrolls inside a short viewport with apply always visible', async ({ page }, info) => {
    await page.route('https://canvas-control.test/**', route => route.abort());
    await configure(page, url);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('创建17张长计划节点');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control.getByText('17 项操作', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 900, height: 540 });
    const content = control.getByRole('region', { name: '画布控制内容', exact: true });
    await expect.poll(() => content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const apply = control.getByRole('button', { name: '应用整份计划', exact: true });
    const box = (await apply.boundingBox())!;
    expect(box.y).toBeGreaterThan(0); expect(box.y + box.height).toBeLessThanOrEqual(540);
    await content.hover(); await page.mouse.wheel(0, 900);
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(apply).toBeVisible();
    await control.screenshot({ path: info.outputPath('long-review-fixed-actions.png') });
    await apply.click(); await expect(control.getByText('已应用', { exact: true })).toBeVisible();
  });
  test('Gemini 404 keeps the selected model and a deliberate model change makes retry use the new endpoint', async ({ page }) => {
    let requests = 0;
    await page.route('https://generativelanguage.googleapis.com/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests += 1;
      if (route.request().url().includes('/gemini-2.5-flash:')) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, json: { error: { message: 'Model unavailable', status: 'NOT_FOUND' } } });
      expect(route.request().url()).toContain('/gemini-3.5-flash-lite:streamGenerateContent');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '修钟学徒的介绍。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 5, candidatesTokenCount: 40, thoughtsTokenCount: 10 } })}\n\n` });
    });
    await configure(page, url, 'gemini', 'gemini-2.5-flash');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('介绍一位修钟学徒。');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai).toContainText('HTTP 404');
    await expect(ai).toContainText('账号当前可用的模型');
    expect(requests).toBe(1);
    await openModelSettings(page);
    const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
    await expect(provider.getByLabel('模型', { exact: true })).toHaveValue('gemini-2.5-flash');
    await provider.getByLabel('模型', { exact: true }).fill('gemini-3.5-flash-lite');
    await provider.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(provider.getByText('当前连接已就绪', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭 AI 模型连接', exact: true }).click();
  await ai.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await ai.getByRole('button', { name: '重试上一次发送', exact: true }).click();
    await expect(ai.getByRole('log')).toContainText('修钟学徒的介绍。');
    expect(requests).toBe(2);
    const task = ai.getByLabel('任务累计 Token 用量', { exact: true });
    await task.locator(':scope > summary').click();
    await expect(task).toContainText('平台返回：输入 105 · 输出 50');
    await expect(task).toContainText('用量未知：输入 1 次 · 输出 1 次');
    await expect(task).toContainText('修正、续写及重试 1 次');
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText('本轮 Token：输入 105 · 输出 50');
  });
  test('a prose response containing canvas actions is rejected without a paid plan repair', async ({ page }) => {
    let requests = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      requests++;
      const content = JSON.stringify({ texts: ['不应写入'], actions: [{ type: 'delete', ids: ['other'] }] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const before = await page.locator('.text-node-card').count();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('创建一张人物卡，并写一段小传');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai).toContainText('没有返回符合本轮写入范围的正文');
    await expect(page.locator('.text-node-card')).toHaveCount(before);
    expect(requests).toBe(1);
  });

  for (const failure of ['format', 'scope'] as const) test(`AI prose ${failure} failure releases its task and allows an explicit retry`, async ({ page }) => {
    let requests = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      requests++;
      const content = JSON.stringify(requests === 1 ? (failure === 'format' ? { text: '错误字段' } : { texts: ['正文'], id: 'other' }) : { texts: ['重试后的正文'] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('创建一张人物卡，并写一段小传');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai).toContainText('没有返回符合本轮写入范围的正文');
    await ai.getByRole('button', { name: '重试上一次发送', exact: true }).click();
    await expect(page.getByRole('article', { name: /文本节点：人物卡$/u })).toContainText('重试后的正文');
    expect(requests).toBe(2);
  });
  test('AI node editing binds the selected object and refuses a review after the user edits it', async ({ page }) => {
    test.setTimeout(60_000);
    let requests = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests++;
      const request = route.request().postDataJSON() as { tools?: unknown; messages: Array<{ content: string }> };
      expect(request.tools).toBeUndefined();
      expect(request.messages.some(message => message.content.includes('AI 助手使用指南'))).toBe(true);
      const text = JSON.stringify({ text: 'AI 的旧计划正文' });
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
    expect(requests).toBe(1);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await source.focus(); await source.press('Enter');
    const editor = page.locator('.editor-writing-area').first();
    await editor.focus(); await editor.press('Control+End'); await page.keyboard.insertText('用户保留的最新编辑🧭');
    await page.getByRole('button', { name: '关闭编辑器', exact: true }).click();
    await openControl(page);
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
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56 } })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url);
    const before = await page.locator('.text-node-card').count();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill(LOCAL_MIXED_GRAPH);
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control).toBeVisible();
    await expect(control.getByText('6 项操作', { exact: true })).toBeVisible();
    await expect(page.locator('.text-node-card')).toHaveCount(before);
    await expect(ai).not.toContainText('"create-node"');
    await expect(ai).toContainText('已生成 6 项画布操作计划');
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText('本轮 Token：输入 0 · 输出 0');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ai.screenshot({ path: info.outputPath('token-footer.png') });
    expect(requestText).toBe('');
    await openControl(page);
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
    const responseDetails = Object.values(project.document.namespaces.aiResponseDetails) as Array<{ usage?: { inputTokens: number; outputTokens: number } }>;
    expect(responseDetails.some(detail => detail.usage?.inputTokens === 0 && detail.usage.outputTokens === 0)).toBe(true);
    expect(JSON.stringify(project.document)).not.toContain('<untrusted-canvas-objects>');
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).locator('input[type=file]').setInputFiles({ name: '画布控制结果.e8', mimeType: 'application/octet-stream', buffer });
    await expect(page.getByRole('article', { name: /文本节点：主角｜林渊$/u })).toBeVisible();
    await expect(page.locator('.group-frame')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

async function openControl(page: Page): Promise<void> {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('画布控制');
  await palette.getByRole('option', { name: /^画布控制/u }).click();
}

async function seedCanvas(page: Page, url: string, nodes: Array<{ title: string; body?: string; color?: string }>, clean = false): Promise<void> {
  const kernel = new ApplicationKernel([createTextNodePlugin(), ...(clean ? [createSelectionPlugin()] : [])]);
  await kernel.start();
  if (clean) {
    const initial = await kernel.capabilities.request<Array<{id: string}>>('content.summaries@1');
    await kernel.router.dispatch('selection.set', { ids: initial.map(node => node.id) }, 'core.test');
    await kernel.router.dispatch('selection.delete', undefined, 'core.test');
  }
  for (const [index, node] of nodes.entries()) await kernel.router.dispatch('node.create', { ...node, x: index * 440, y: 240 }, 'core.test');
  const source = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const book = await serializeProject(source);
  if (clean) await kernel.plugins.stop('selection');
  await kernel.plugins.stop('text-node');
  await page.goto(url);
  await page.getByRole('region', { name: 'Echo-8 书库' }).locator('input[type=file]').setInputFiles({
    name: '本地测试.e8', mimeType: 'application/octet-stream', buffer: Buffer.from(await book.arrayBuffer()),
  });
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toHaveCount(0);
}

async function configure(page: Page, url: string, preset: 'openai' | 'gemini' | 'deepseek' = 'openai', model?: string, execution: 'direct' | 'review' = 'review', openCanvas = true): Promise<void> {
  if (openCanvas) {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  }
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
  await openModelSettings(page);
  const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
  await provider.getByRole('combobox', { name: '选择平台', exact: true }).selectOption(preset);
  if (model) await provider.getByLabel('模型', { exact: true }).fill(model);
  await provider.getByLabel('API KEY', { exact: true }).fill('test-key-not-real');
  await provider.getByText('自定义地址（可选）', { exact: true }).click();
  await provider.getByLabel('完整接口地址', { exact: true }).fill(preset === 'gemini' ? 'https://generativelanguage.googleapis.com' : preset === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://canvas-control.test/v1/chat/completions');
  await provider.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(provider.getByText('当前连接已就绪', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭 AI 模型连接', exact: true }).click();
    await ai.getByRole('button', { name: 'AI 对话', exact: true }).click();
  if (execution === 'review') {
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await palette.getByRole('textbox', { name: '搜索命令' }).fill('画布控制');
    await palette.getByRole('option', { name: /^画布控制/u }).click();
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await control.getByRole('combobox', { name: '画布生成方式', exact: true }).selectOption('review');
    await control.getByRole('button', { name: '关闭画布控制', exact: true }).click();
  }
}
