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
    await expect(ai.getByRole('combobox', { name: /模型平台/u })).toBeVisible();
    await ai.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await composer.fill('保存当前AI对话存档');
    await composer.press('Enter');
    await expect(ai.getByRole('status')).toContainText('当前对话原文与索引已保存到本地存档');
    await ai.getByRole('button', { name: 'AI 记忆中心', exact: true }).click();
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
    const composer = page.getByRole('region', { name: 'AI 助手', exact: true }).locator('.ai-composer textarea');
    // Leave enough width for the editor owner's minimum pane size at both requested ratios.
    await composer.fill('把编辑区宽度设为1600像素');
    await composer.press('Enter');
    await expect.poll(() => page.locator('.editor-dock').evaluate(dock => Math.round(dock.getBoundingClientRect().width))).toBe(1600);
    await composer.fill('左边编辑器占三分之一，右边占三分之二');
    await composer.press('Enter');
    const widths = () => page.locator('.editor-pane').evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().width));
    await expect.poll(async () => { const values = await widths(); return values[1]! / values[0]!; }).toBeCloseTo(2, 1);
    await openPane('比例丙', true);
    await expect(page.locator('.editor-pane')).toHaveCount(3);
    await composer.fill('并排编辑页按1:2:1分配宽度');
    await composer.press('Enter');
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

  test('fixed plans focus a real group, distinguish relative scale, pan in screen pixels and restore the saved view', async ({ page }) => {
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const command = page.getByRole('dialog', { name: '命令面板' });
    await command.getByRole('textbox', { name: '搜索命令' }).fill('查看本地工作区动作');
    await command.getByRole('option', { name: /查看本地工作区动作/u }).click();
    const panel = page.getByRole('region', { name: '工作区动作', exact: true });
    await page.context().setOffline(true);
    await panel.getByRole('textbox', { name: '固定计划', exact: true }).fill(JSON.stringify({ version: 1, id: 'group-view', steps: [
      { id: 'a', action: 'node.create', arguments: { title: '视口验收甲', x: 200, y: 600 } },
      { id: 'b', action: 'node.create', arguments: { title: '视口验收乙', x: 650, y: 600 } },
      { id: 'group', action: 'group.createExplicit', arguments: { title: '视口验收组', members: [{ from: 'a' }, { from: 'b' }] } },
      { id: 'focus', action: 'viewport.focusEntity', arguments: { entityId: { $step: 'group', path: ['id'] }, zoom: 1 } },
      { id: 'bookmark', action: 'viewport.read', dependsOn: ['focus'] },
      { id: 'pan', action: 'viewport.set', arguments: { pan: { x: 100, y: 0 } }, dependsOn: ['bookmark'] },
      { id: 'panned', action: 'viewport.read', dependsOn: ['pan'] },
      { id: 'relative', action: 'viewport.scale', arguments: { factor: 0.4 }, dependsOn: ['panned'] },
      { id: 'restore', action: 'viewport.restore', arguments: { camera: { $step: 'bookmark' } }, dependsOn: ['relative'] },
    ], verify: [{ action: 'viewport.read', field: ['zoom'], equals: { $step: 'bookmark', path: ['zoom'] } }] }));
    await panel.getByRole('button', { name: '运行固定计划', exact: true }).click();
    await expect(panel.getByText('group-view：等待处理', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '应用此文档预览并继续' }).first().click();
    await expect(panel.getByText('group-view：已完成', { exact: true })).toBeVisible();
    const readResult = async (step: string) => {
      const item = panel.locator('.workspace-action-receipt').filter({ has: page.getByText(step + ' · 已完成', { exact: true }) });
      await item.getByText('实际结果', { exact: true }).click();
      return JSON.parse((await item.locator('pre').textContent())!) as { x: number; y: number; zoom: number };
    };
    const before = await readResult('bookmark'); const moved = await readResult('panned');
    const scaled = await readResult('relative'); const restored = await readResult('restore');
    expect(moved.x - before.x).toBeCloseTo(100, 6); expect(moved.y).toBeCloseTo(before.y, 6);
    expect(scaled.zoom).toBe(0.4); expect(restored.x).toBeCloseTo(before.x, 6); expect(restored.y).toBeCloseTo(before.y, 6);
    await expect(page.getByRole('textbox', { name: /画布缩放/u })).toHaveValue('100');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.text-node-card').filter({ hasText: '视口验收甲' })).toHaveCount(0);
    await expect(page.locator('.text-node-card').filter({ hasText: '视口验收乙' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: /画布缩放/u })).toHaveValue('100');
  });

  test('fixed plans run through the catalog panel and keep one atomic document preview across panel changes', async ({ page }) => {
    const external: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const allowed = new URL(url);
    await page.route('**/*', route => {
      const request = new URL(route.request().url());
      if (['http:', 'https:'].includes(request.protocol) && request.origin !== allowed.origin) {
        external.push(request.origin); return route.abort();
      }
      return route.continue();
    });
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    const showPanel = async () => {
      await page.getByRole('button', { name: '命令面板', exact: true }).click();
      const command = page.getByRole('dialog', { name: '命令面板' });
      await command.getByRole('textbox', { name: '搜索命令' }).fill('查看本地工作区动作');
      await command.getByRole('option', { name: /查看本地工作区动作/u }).click();
      await expect(page.getByRole('region', { name: '工作区动作', exact: true })).toBeVisible();
    };
    await showPanel();
    const panel = page.getByRole('region', { name: '工作区动作', exact: true });
    await expect(panel).toContainText(/66 类 \/ 27 项跨类别能力/u);
    await page.context().setOffline(true);
    await panel.getByRole('textbox', { name: '固定计划', exact: true }).fill(JSON.stringify({ version: 1, id: 'ui-atomic-1', steps: [
      { id: 'hero', action: 'node.create', arguments: { title: '固定计划主角', text: '本地固定稿件', x: 200, y: 100 } },
      { id: 'case', action: 'node.create', arguments: { title: '固定计划旧案', x: 650, y: 100 } },
      { id: 'edge', action: 'connection.create', arguments: { from: { from: 'hero' }, to: { from: 'case' }, line: 'dashed' } },
      { id: 'open', action: 'editor.open', arguments: { target: { from: 'hero' }, mode: 'add' } },
    ] }));
    await panel.getByRole('button', { name: '运行固定计划', exact: true }).click();
    const apply = page.getByRole('button', { name: '应用整份计划', exact: true });
    await expect(apply).toBeVisible();
    await expect(page.locator('.text-node-card').filter({ hasText: '固定计划主角' })).toHaveCount(0);
    await apply.click();
    await expect(page.locator('.text-node-card').filter({ hasText: '固定计划主角' })).toHaveCount(1);
    await expect(page.locator('.text-node-card').filter({ hasText: '固定计划旧案' })).toHaveCount(1);
    await showPanel();
    await expect(panel.getByRole('textbox', { name: '固定计划', exact: true })).toHaveValue(/ui-atomic-1/u);
    await panel.getByRole('button', { name: '回读并继续', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '固定计划主角 正文', exact: true })).toBeVisible();
    await showPanel();
    await expect(panel.getByLabel('计划回执')).toContainText('ui-atomic-1：已完成');
    await panel.getByRole('button', { name: '运行固定计划', exact: true }).click();
    await expect(page.locator('.text-node-card').filter({ hasText: '固定计划主角' })).toHaveCount(1);
    expect(external).toEqual([]); expect(errors).toEqual([]);
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
    await command.getByRole('textbox', { name: '搜索命令' }).fill('查看本地工作区动作');
    await command.getByRole('option', { name: /查看本地工作区动作/u }).click();
    const actions = page.getByRole('region', { name: '工作区动作', exact: true });
    await actions.getByRole('textbox', { name: '固定计划', exact: true }).fill(JSON.stringify({ version: 1, id: 'geometry-export', steps: [
      { id: 'copy', action: 'file.copy' },
    ] }));
    const downloaded = page.waitForEvent('download');
    await actions.getByRole('button', { name: '运行固定计划', exact: true }).click();
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
