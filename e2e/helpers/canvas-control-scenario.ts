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
    for (const prompt of ['填入角色卡', '@画布操作 在角色卡节点里，设计人物']) {
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
    expect(calls).toBe(3);
    await candidates.getByRole('button').click();
    await expect(control.getByRole('button', { name: '应用整份计划' })).toBeVisible();
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('region', { name: '画布操作计划' }).first()).toContainText('已应用');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    expect(calls).toBe(4);
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
      const content = JSON.stringify({ version: 1, actions: [{ type: 'create-node', ref: 'record', title: '日志测试节点', text: 'private-node-body-724', x: 420, y: 340 }] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const log = page.getByRole('region', { name: '实时操作日志', exact: true });
    const row = (label: string) => log.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
    try {
      await ai.locator('.ai-composer textarea').fill('新建一个记录节点，使用 private-prompt-724 主题');
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
    await ai.locator('.ai-composer textarea').fill('新建测试节点，主题 private-model-failure-724');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(row('模型响应')).toContainText('失败');
    await expect(log).not.toContainText('private-provider-error-724');
  });

  test('natural character creation corrects an empty plan that misreports the text-node capability', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls++;
      const { messages } = route.request().postDataJSON() as { messages: Array<{ role: string; content: string }> };
      expect(messages.filter(message => message.role === 'system').map(message => message.content).join('\n')).toContain('文字节点已启用，支持 create-node 和 update-node');
      if (calls === 2) expect(messages.at(-1)?.content).toContain('返回计划没有 create-node');
      const content = JSON.stringify(calls === 1
        ? { version: 1, actions: [], answer: '节点插件未启用。' }
        : { version: 1, actions: [{ type: 'create-node', ref: 'character', title: '角色｜沈砚', text: '夜班测绘员。' }] });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('创建一张角色卡，并为她写一段背景故事');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const card = page.getByRole('article', { name: '文本节点：角色｜沈砚' });
    await expect(card).toContainText('夜班测绘员。');
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项');
    await expect(ai).not.toContainText('节点插件未启用');
    expect(calls).toBe(2);
    await page.getByRole('button', { name: /^撤销/u }).click();
    await expect(card).toHaveCount(0);
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
      if (calls === 2) {
        const wire = request.messages.map(message => message.content).join('\n');
        expect(wire).toContain('出生于渡口。');
        expect(wire).toContain('出生于港城。');
      }
      const content = calls === 1 ? JSON.stringify({ version: 1, actions: [
        { type: 'create-node', ref: 'draft-a', title: '初稿', text: '出生于渡口。' },
        { type: 'create-node', ref: 'draft-b', title: '终稿', text: '出生于港城。' },
      ] }) : '两稿的出生地不同。';
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await send('@画布操作 新建两个测试节点');
    await expect(ai.getByRole('status')).toContainText('已直接完成 2 项');
    await send('对比初稿和终稿，并把冲突整理成名为「人物冲突」的新节点');
    const card = page.getByRole('article', { name: '文本节点：人物冲突' });
    const review = ai.getByRole('dialog', { name: '新建结果节点确认' });
    await expect(review).toContainText('两稿的出生地不同。');
    await expect(card).toHaveCount(0);
    await review.getByRole('button', { name: '创建节点' }).click();
    await expect(card).toContainText('两稿的出生地不同。');
    expect(calls).toBe(2);
  });

  test('retrieval settings are governed, show honest versions and retain mode without a model connection', async ({ page }, info) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.getByRole('button', { name: '配置模型平台与 KEY', exact: true }).click();
    await ai.getByRole('button', { name: '打开检索设置', exact: true }).click();
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
    await ai.getByRole('button', { name: '打开检索设置', exact: true }).click();
    await expect(mode).toHaveValue('keyword');
    await mode.selectOption('cloud-fallback');
    await expect(settings).toContainText('云端连接仍需独立授权');
  });
  test('semantic filter sends only the request, resolves candidates locally, then moves the same result set without another call', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      if (calls === 2) {
        expect(request.messages).toHaveLength(2);
        expect(request.messages.map(message => message.content).join('\n')).not.toContain('渡口账本');
      }
      const content = calls === 1 ? JSON.stringify({ version: 1, actions: [
        { type: 'create-node', ref: 'hit', title: '渡口账本', text: '旧案留下的潮汐记录。' },
        { type: 'create-node', ref: 'other', title: '无关测试', text: '食谱。' },
      ] }) : JSON.stringify({ terms: ['旧案'], ungrouped: true });
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await send('@画布操作 新建两个测试节点');
    await expect(ai.getByRole('status')).toContainText('已直接完成 2 项');
    await send('把跟旧案有关、但还没归类的线索整理出来');
    await expect(control.getByRole('button', { name: '渡口账本', exact: true })).toBeVisible();
    await expect(control.getByRole('button', { name: '无关测试', exact: true })).toHaveCount(0);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await send('把它们移到右边');
    await expect(control).toContainText('修改文字对象 · 渡口账本');
    await expect(control).toContainText('1 项待应用');
    expect(calls).toBe(2);
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('button', { name: '应用整份计划' })).toHaveCount(0);
  });
  test('a described paragraph is rewritten in place and a short follow-up uses the applied text', async ({ page }) => {
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      if (calls > 1) {
        const wire = request.messages.map(message => message.content).join('\n');
        expect(wire).toContain(calls === 2 ? '左腕有一道旧伤，阴天时会痛。' : '旧伤遇潮便痛。');
        expect(wire).not.toContain('远处绝不应发送');
        if (calls === 3) expect(wire).toContain('不要修改人物年龄');
      }
      const content = calls === 1 ? JSON.stringify({ version: 1, actions: [{ type: 'create-node', ref: 'hero', title: '旧伤验收', text: '前文保留。\n\n左腕有一道旧伤，阴天时会痛。\n\n后文保留。' + '隔'.repeat(400) + '远处绝不应发送' }] })
        : calls === 2 ? '旧伤遇潮便痛。' : '旧伤畏潮。';
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const send = async (prompt: string) => {
      await ai.locator('.ai-composer textarea').fill(prompt);
      await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    };
    await send('@画布操作 新建旧伤验收节点');
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项');
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
    expect(calls).toBe(3);
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
  test('flexible canvas requests use the model plan with a bounded title directory', async ({ page }) => {
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
    expect(requests).toBe(1);
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
    await send('@画布操作 新建测试主角和测试武器，并连线');
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
    expect(calls).toBe(1);
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
      const directory = request.messages.find(message => message.content.startsWith('<untrusted-canvas-objects>'))?.content.split('\n')[1] ?? '{}';
      const protagonist = (JSON.parse(directory) as { nodes?: Array<{ id: string; title: string; textLength: number }> }).nodes?.find(node => node.title === '待设计主角');
      const content = calls === 1
        ? { version: 1, actions: [{ type: 'create-node', ref: 'hero', title: '待设计主角' }] }
        : { version: 1, actions: [{ type: 'update-node', id: protagonist?.id, text: '林渊在夜里修表，害怕钟声。' }] };
      return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    for (const prompt of ['@画布操作 添加主角节点', '@画布操作 设计主角']) {
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
    expect(calls).toBe(2);
  });
  test('paragraph rewrite sends a bound range and applies only the replacement with one undo', async ({ page }) => {
    test.setTimeout(60_000);
    let calls = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      calls += 1;
      if (calls === 2) {
        const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
        const target = request.messages.find(message => message.content.startsWith('本轮正文目标'))?.content;
        expect(target).toContain('"start":8'); expect(target).toContain('"end":14');
        expect(request.messages.some(message => message.content.includes('第二段原文。'))).toBe(true);
      }
      const content = calls === 1 ? JSON.stringify({ version: 1, actions: [{ type: 'create-node', ref: 'body', title: '段落目标', text: '第一段保留。\n\n第二段原文。\n\n第三段保留。' }] }) : '第二段的新表达。';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 新建一个正文节点');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项');
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
    expect(calls).toBe(2);
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
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 新建一个人物节点');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai.getByRole('status')).toContainText('已直接完成 1 项');
    await ai.locator('.ai-composer textarea').fill('@画布操作 把选中节点设为 #336699');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control.getByText('1 项操作', { exact: true }).first()).toBeVisible();
    expect(requests).toBe(1);
    await expect(ai.getByLabel('本轮 Token 用量').last()).toHaveText('本轮 Token：输入 0 · 输出 0');
    await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    const card = page.getByRole('article', { name: /文本节点：本地改色目标$/u });
    await expect(card.locator('header')).toHaveCSS('background-color', 'rgb(51, 102, 153)');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(card.locator('header')).toHaveCSS('background-color', 'rgb(168, 61, 68)');
    await expect(card).toContainText('原文必须保留。');
  });
  test('new objects generate directly by default and one undo reverses the whole generated batch', async ({ page }) => {
    await page.route('https://canvas-control.test/**', route => route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      : route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` }));
    await configure(page, url, 'openai', undefined, 'direct');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 新建人物与章节并分组连线。');
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
    const largePlan: CanvasControlPlan = { version: 1, actions: Array.from({ length: 17 }, (_, index) => ({ type: 'create-node' as const, ref: `long-${index}`, title: `长计划节点 ${index + 1}`, text: '长计划正文。'.repeat(80) })) };
    await page.route('https://canvas-control.test/**', route => route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      : route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(largePlan) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` }));
    await configure(page, url);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 生成17个独立对象。');
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
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 5, candidatesTokenCount: 40, thoughtsTokenCount: 10 } })}\n\n` });
    });
    await configure(page, url, 'gemini', 'gemini-2.5-flash');
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 新建人物与章节并分组连线。');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai).toContainText('HTTP 404');
    await expect(ai).toContainText('账号当前可用的模型');
    expect(requests).toBe(1);
    await ai.getByRole('button', { name: '配置模型平台与 KEY', exact: true }).click();
    const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
    await expect(provider.getByLabel('模型', { exact: true })).toHaveValue('gemini-2.5-flash');
    await provider.getByLabel('模型', { exact: true }).fill('gemini-3.5-flash-lite');
    await provider.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(provider.getByText('当前连接已就绪', { exact: true })).toBeVisible();
    await ai.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await ai.getByRole('button', { name: '重试上一次发送', exact: true }).click();
    await expect(page.getByRole('region', { name: '画布控制', exact: true }).getByText('6 项操作', { exact: true })).toBeVisible();
    expect(requests).toBe(2);
    await page.getByRole('region', { name: '画布控制', exact: true }).getByRole('button', { name: '关闭画布控制' }).click();
    const task = ai.getByLabel('任务累计 Token 用量', { exact: true });
    await task.locator(':scope > summary').click();
    await expect(task).toContainText('平台返回：输入 105 · 输出 50');
    await expect(task).toContainText('用量未知：输入 1 次 · 输出 1 次');
    await expect(task).toContainText('修正、续写及重试 1 次');
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText('本轮 Token：输入 105 · 输出 50');
  });
  test('AI canvas plans get one bounded format repair before review', async ({ page }) => {
    let requests = 0;
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests += 1;
      const content = requests === 1 ? { version: '1', nodes: [] } : plan;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: requests * 10, completion_tokens: requests + 1 } })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 新建人物与章节并分组连线。');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(page.getByRole('region', { name: '画布控制', exact: true }).getByText('6 项操作', { exact: true })).toBeVisible();
    expect(requests).toBe(2);
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText('本轮 Token：输入 30 · 输出 5');
    await page.getByRole('region', { name: '画布控制', exact: true }).getByRole('button', { name: '关闭画布控制' }).click();
    const task = ai.getByLabel('任务累计 Token 用量', { exact: true });
    await task.locator(':scope > summary').click();
    await expect(task).toContainText('平台返回：输入 30 · 输出 5');
    await task.getByText('调用明细', { exact: true }).click();
    await expect(task).toContainText('格式纠正');
    await ai.getByRole('button', { name: '查看发送内容', exact: true }).click();
    const inspection = page.getByRole('dialog', { name: '本轮发送内容', exact: true });
    await expect(inspection.getByLabel('实际请求正文')).toHaveCount(2);
    await expect(inspection).toContainText('计划校验未通过');
    await page.keyboard.press('Escape'); await expect(inspection).toHaveCount(0);
    await expect(ai).not.toContainText('"nodes"');
  });
  for (const failure of ['format', 'scope'] as const) test(`AI ${failure} failure releases the completed task and allows retry`, async ({ page }) => {
    let requests = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requests += 1;
      const bad = failure === 'format' ? { version: '1', nodes: [] }
        : { version: 1, actions: [{ type: 'update-node', id: 'outside:node', text: '不得写入' }] };
      const content = requests <= (failure === 'format' ? 2 : 1) ? bad : plan;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url);
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 新建人物与章节并分组连线。');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    await expect(ai).toContainText(failure === 'format' ? '版本或字段不正确' : '控制范围外');
    await ai.getByRole('button', { name: '重试上一次发送', exact: true }).click();
    await expect(page.getByRole('region', { name: '画布控制', exact: true }).getByText('6 项操作', { exact: true })).toBeVisible();
    expect(requests).toBe(failure === 'format' ? 3 : 2);
    await expect(ai.getByLabel('本轮 Token 用量')).toContainText('（估算）');
    await expect(ai).not.toContainText('当前内容仍在处理中');
    expect(errors).toEqual([]);
  });
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
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56 } })}\n\ndata: [DONE]\n\n` });
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
    await expect(ai.getByLabel('本轮 Token 用量')).toHaveText('本轮 Token：输入 1,234 · 输出 56');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ai.screenshot({ path: info.outputPath('token-footer.png') });
    const inspectRequest = ai.getByRole('button', { name: '查看发送内容', exact: true });
    await expect(inspectRequest).toHaveAttribute('title', '查看发送内容');
    await expect(inspectRequest).toHaveText('');
    await expect(inspectRequest.locator('svg')).toHaveCount(1);
    await inspectRequest.click();
    const inspection = page.getByRole('dialog', { name: '本轮发送内容', exact: true });
    await expect(inspection).toBeVisible();
    expect(JSON.parse((await inspection.getByLabel('实际请求正文').textContent())!)).toEqual(JSON.parse(requestText));
    await inspection.getByText('请求头（密钥已隐藏）', { exact: true }).click();
    await expect(inspection).toContainText('[密钥已隐藏]');
    await expect(inspection).not.toContainText('test-key-not-real');
    await inspection.screenshot({ path: info.outputPath('request-inspection.png') });
    await page.locator('.confirmation-dialog-backdrop').click({ position: { x: 4, y: 4 } });
    await expect(inspection).toHaveCount(0);
    await page.getByRole('button', { name: '画布控制', exact: true }).click();
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
    const responseDetails = Object.values(project.document.namespaces.aiResponseDetails) as Array<{ usage?: { inputTokens: number; outputTokens: number } }>;
    expect(responseDetails.some(detail => detail.usage?.inputTokens === 1234 && detail.usage.outputTokens === 56)).toBe(true);
    expect(JSON.stringify(project.document)).not.toContain('<untrusted-canvas-objects>');
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).locator('input[type=file]').setInputFiles({ name: '画布控制结果.e8', mimeType: 'application/octet-stream', buffer });
    await expect(page.getByRole('article', { name: /文本节点：主角｜林渊$/u })).toBeVisible();
    await expect(page.locator('.group-frame')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

async function configure(page: Page, url: string, preset: 'openai' | 'gemini' = 'openai', model?: string, execution: 'direct' | 'review' = 'review', openCanvas = true): Promise<void> {
  if (openCanvas) {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  }
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
  await ai.getByRole('button', { name: '配置模型平台与 KEY', exact: true }).click();
  const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
  await provider.getByRole('combobox', { name: '选择平台', exact: true }).selectOption(preset);
  if (model) await provider.getByLabel('模型', { exact: true }).fill(model);
  await provider.getByLabel('API KEY', { exact: true }).fill('test-key-not-real');
  await provider.getByText('自定义地址（可选）', { exact: true }).click();
  await provider.getByLabel('完整接口地址', { exact: true }).fill(preset === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://canvas-control.test/v1/chat/completions');
  await provider.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(provider.getByText('当前连接已就绪', { exact: true })).toBeVisible();
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
