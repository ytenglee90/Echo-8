import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ApplicationKernel } from '../../src/core/kernel.ts';
import { parseProject, serializeProject } from '../../src/plugins/import-export/codec.ts';
import { createTextNodePlugin } from '../../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../../src/plugins/connections/model.ts';
import type { ProjectSource } from '../../src/protocols/files.ts';

export function workspaceActionsScenario(url: string): void {
  test('offline named duplication preserves internal relations and the entire copy undoes once', async ({ page }) => {
    const external: string[] = [];
    const allowed = new URL(url);
    await page.route('**/*', route => {
      const request = new URL(route.request().url());
      if (request.pathname === '/api/cloud/status') return route.fulfill({ json: { configured: false, authenticated: false, accounts: [], installations: [] } });
      if (['http:', 'https:'].includes(request.protocol) && (request.origin !== allowed.origin || request.pathname.startsWith('/api/'))) {
        external.push(request.origin + request.pathname); return route.abort();
      }
      return route.continue();
    });
    const fixture = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createConnectionsPlugin()]);
    await fixture.start();
    const initial = await fixture.capabilities.request<Array<{ id: string }>>('content.summaries@1');
    await fixture.router.dispatch('selection.set', { ids: initial.map(node => node.id) }, 'core.test');
    await fixture.router.dispatch('selection.delete', undefined, 'core.test');
    const first = await fixture.router.dispatch<{ id: string }>('node.create', { title: '关系甲', body: '原件甲正文', x: 100, y: 80 }, 'core.test');
    const second = await fixture.router.dispatch<{ id: string }>('node.create', { title: '关系乙', body: '原件乙正文', x: 500, y: 80 }, 'core.test');
    await fixture.router.dispatch('connection.create', { from: { nodeId: first.id, side: 'title' }, to: { nodeId: second.id, side: 'title' } }, 'core.test');
    const source = await fixture.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
    const file = await serializeProject(source);
    for (const plugin of fixture.plugins.list().reverse()) if (plugin.status === 'active') await fixture.plugins.stop(plugin.id);
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '关系复制.e8', mimeType: 'application/octet-stream', buffer: Buffer.from(await file.arrayBuffer()) });
    await expect(library).toHaveCount(0);
    await expect(page.locator('.text-node-card')).toHaveCount(2);
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const composer = page.getByRole('region', { name: 'AI 助手', exact: true }).locator('.ai-composer textarea');
    await composer.fill('把「关系甲」和「关系乙」连同内部关系复制到右边');
    await composer.press('Enter');
    await expect(page.locator('.text-node-card')).toHaveCount(4);
    await expect(page.getByRole('region', { name: 'AI 助手', exact: true })).toContainText('原对象保留');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.text-node-card')).toHaveCount(2);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.locator('.text-node-card')).toHaveCount(4);
    expect(external).toEqual([]);
  });

  test('local sequences compose settings and views and archive the real conversation after commit', async ({ page }) => {
    const external: string[] = [];
    const allowed = new URL(url);
    await page.route('**/*', route => {
      const request = new URL(route.request().url());
      if (request.pathname === '/api/cloud/status') return route.fulfill({
        json: { configured: false, authenticated: false, accounts: [], installations: [] },
      });
      if (['http:', 'https:'].includes(request.protocol) &&
        (request.origin !== allowed.origin || request.pathname.startsWith('/api/'))) {
        external.push(request.origin + request.pathname);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const composer = ai.locator('.ai-composer textarea');
    await composer.fill('先把画布缩放到60%，然后打开模型连接设置，再显示小地图');
    await composer.press('Enter');
    await expect(page.getByRole('textbox', { name: /画布缩放/u })).toHaveValue('60');
    await expect(page.getByRole('region', { name: '画布小地图', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭 AI 模型连接', exact: true }).click();
    await ai.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await composer.fill('保存当前AI对话存档');
    await composer.press('Enter');
    await expect(ai.getByRole('status')).toContainText('当前对话原文与索引已保存到本地存档');
    await ai.getByRole('button', { name: '选择本轮记忆，前往记忆中心', exact: true }).click();
    await ai.getByRole('button', { name: '打开原文', exact: true }).first().click();
    await expect(page.locator('.editor-writing-area')).toContainText('先把画布缩放到60%');
    expect(external).toEqual([]);
  });

  test('pane ratios bind the open panes for fractional and three-part instructions', async ({ page }) => {
    await page.setViewportSize({ width: 3000, height: 900 });
    const fixture = new ApplicationKernel([createTextNodePlugin()]);
    await fixture.start();
    for (const [index, title] of ['比例甲', '比例乙', '比例丙'].entries()) {
      await fixture.router.dispatch('node.create', { title, body: title + '的正文', x: 60 + index * 360, y: 80 }, 'core.test');
    }
    const project = await fixture.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
    const book = await serializeProject(project);
    await fixture.plugins.stop('text-node');
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({
      name: '窗格比例.e8', mimeType: 'application/octet-stream', buffer: Buffer.from(await book.arrayBuffer()),
    });
    await expect(library).toHaveCount(0);
    const openPane = async (title: string, add: boolean) => {
      await page.getByRole('article', { name: new RegExp('文本节点：' + title + '$', 'u') })
        .getByRole('paragraph').dispatchEvent('dblclick', { shiftKey: add });
    };
    await openPane('比例甲', false);
    await openPane('比例乙', true);
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const composer = ai.locator('.ai-composer textarea');
    const ask = async (prompt: string) => {
      const replies = ai.locator('.ai-chat-bubble.assistant:not(.ai-streaming-response)');
      const count = await replies.count();
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
      await composer.fill(prompt); await composer.press('Enter');
      await expect(replies).toHaveCount(count + 1);
      await expect(ai.getByRole('button', { name: '发送给模型', exact: true })).toBeVisible();
    };
    // Leave enough width for the editor owner's minimum pane size at both requested ratios.
    await ask('把编辑区宽度设为1600像素');
    await expect.poll(() => page.locator('.editor-dock').evaluate(dock => Math.round(dock.getBoundingClientRect().width))).toBe(1600);
    await ask('左边编辑器占三分之一，右边占三分之二');
    const widths = () => page.locator('.editor-pane').evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().width));
    await expect.poll(async () => { const values = await widths(); return values[1]! / values[0]!; }).toBeCloseTo(2, 1);
    await openPane('比例丙', true);
    await expect(page.locator('.editor-pane')).toHaveCount(3);
    await ask('并排编辑页按1:2:1分配宽度');
    await expect.poll(async () => { const values = await widths(); return values[1]! / values[0]!; }).toBeCloseTo(2, 1);
    await expect.poll(async () => { const values = await widths(); return values[2]! / values[0]!; }).toBeCloseTo(1, 1);
  });

  test('the assistant belongs to the canvas and restores its draft after returning from the library', async ({ page }) => {
    const external: string[] = [];
    const errors: string[] = [];
    const allowed = new URL(url);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = new URL(route.request().url());
      if (request.pathname === '/api/cloud/status') {
        return route.fulfill({ json: { configured: false, authenticated: false, accounts: [], installations: [] } });
      }
      if (['http:', 'https:'].includes(request.protocol) &&
        (request.origin !== allowed.origin || request.pathname.startsWith('/api/'))) {
        external.push(request.origin + request.pathname);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await expect(library.getByRole('button', { name: '在书库打开 AI 助手', exact: true })).toHaveCount(0);
    await library.press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await expect(ai).toBeVisible();
    const composer = ai.locator('.ai-composer textarea');
    const send = async (message: string) => {
      await composer.fill(message);
      await composer.press('Enter');
    };
    await send('返回当前画布');
    await expect(library).toHaveCount(0);
    await composer.fill('切换书库时保留这段未发送的草稿');
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const commands = page.getByRole('dialog', { name: '命令面板' });
    await commands.getByRole('textbox', { name: '搜索命令' }).fill('返回首页（书库）');
    await commands.getByRole('option', { name: /返回首页（书库）/u }).click();
    await expect(library).toBeVisible();
    await expect(ai).toBeHidden();
    await library.press('Escape');
    await expect(library).toHaveCount(0);
    await expect(composer).toHaveValue('切换书库时保留这段未发送的草稿');
    await send('打开书库');
    await expect(library).toBeVisible();
    await expect(ai).toBeHidden();
    await library.press('Escape');
    await expect(library).toHaveCount(0);
    await expect(ai).toHaveCount(1);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('developer plan tooling is absent from the command palette', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const commands = page.getByRole('dialog', { name: '命令面板' });
    await expect(commands.getByRole('group', { name: '开发者工具', exact: true })).toHaveCount(0);
    await commands.getByRole('textbox', { name: '搜索命令' }).fill('固定计划');
    await expect(commands.getByRole('option')).toHaveCount(0);
  });

  test('offline assistant focuses the actual card at exactly 60 percent and opens the minimap', async ({ page }) => {
    const external: string[] = [];
    const allowed = new URL(url);
    await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }); });
    await page.route('**/*', route => {
      const request = new URL(route.request().url());
      if ((request.protocol === 'http:' || request.protocol === 'https:') && request.origin !== allowed.origin) {
        external.push(request.origin);
        return route.abort();
      }
      return route.continue();
    });
    const fixture = new ApplicationKernel([createTextNodePlugin()]);
    await fixture.start();
    await fixture.router.dispatch('node.create', { title: '空白1', x: 550, y: 320 }, 'core.test');
    const project = await fixture.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
    const file = await serializeProject(project);
    await fixture.plugins.stop('text-node');

    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({
      name: '本地工作区验收.e8', mimeType: 'application/octet-stream', buffer: Buffer.from(await file.arrayBuffer()),
    });
    await expect(library).toHaveCount(0);
    const card = page.locator('.text-node-card').filter({ hasText: '空白1' });
    await expect(card).toHaveCount(1);
    const documentPosition = await card.evaluate(element => {
      const position = new DOMMatrix(getComputedStyle(element).transform);
      return { x: position.e, width: (element as HTMLElement).style.width };
    });
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await expect(ai).toBeVisible();
    await page.context().setOffline(true);
    const composer = ai.locator('.ai-composer textarea');
    await composer.fill('聚焦到空白1，保持 60%，打开小地图');
    await composer.press('Enter');
    await expect(ai).toContainText('已聚焦「空白1」');
    await expect(ai).toContainText('小地图已打开');
    await expect(page.getByRole('textbox', { name: /画布缩放/u })).toHaveValue('60');
    await expect(page.getByLabel('画布小地图', { exact: true })).toBeVisible();
    const canvas = page.locator('.canvas-surface');
    await expect.poll(async () => {
      const node = (await card.boundingBox())!;
      const view = (await canvas.boundingBox())!;
      return Math.max(Math.abs(node.x + node.width / 2 - view.x - view.width / 2),
        Math.abs(node.y + node.height / 2 - view.y - view.height / 2));
    }).toBeLessThan(3);
    expect(await card.evaluate(element => {
      const position = new DOMMatrix(getComputedStyle(element).transform);
      return { x: position.e, width: (element as HTMLElement).style.width };
    })).toEqual(documentPosition);
    // Independently inspect the saved document instead of treating zoom-adjusted DOM geometry as document coordinates.
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const command = page.getByRole('dialog', { name: '命令面板' });
    await command.getByRole('textbox', { name: '搜索命令' }).fill('另存本地副本');
    const downloaded = page.waitForEvent('download');
    await command.getByRole('option', { name: /^另存本地副本/u }).click();
    const artifact = await downloaded;
    const saved = await parseProject(new Blob([await readFile((await artifact.path())!)]));
    for (const [id, node] of Object.entries(project.document.namespaces.textNode!)) {
      expect(saved.document.namespaces.textNode?.[id]).toEqual(node);
    }
    const originalIds = new Set(Object.keys(project.document.namespaces.textNode!));
    const unexpectedPublicNodes = Object.entries(saved.document.namespaces.textNode!).filter(([id, node]) =>
      !originalIds.has(id) && (node as { placement?: string }).placement !== 'system');
    expect(unexpectedPublicNodes).toEqual([]);
    expect(external).toEqual([]);
  });
}
